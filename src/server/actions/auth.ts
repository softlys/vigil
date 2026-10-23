"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { db as getSql } from "../db";
import { DUMMY_HASH, hashPassword, verifyPassword } from "@/lib/passwords";
import { hitLimit, resetLimit } from "@/lib/rate-limit";
import { action, ActionError } from "../action";
import { abandonMfa, completeMfa, createSession, destroySession, getCurrentUser, getPendingMfa, mustSetUpMfa, requestMeta } from "../session";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/totp";
import { loadFactorUser, verifySecondFactor } from "../two-factor";

const loginInput = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export type LoginState = { error: string | null; email: string; /** The password was right; ask for the second factor. */ mfa?: boolean };

/** Failed attempts before an account is locked, and for how long. */
const LOCKOUT = { attempts: 5, minutes: 15 } as const;
const LOCKED_MESSAGE = `Too many failed attempts. Sign-in for this account is paused for ${LOCKOUT.minutes} minutes.`;

/** Only same-site paths are accepted as a destination after sign-in (no open redirects). */
function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") && !next.startsWith("/login") ? next : "/";
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign-in:
 * - the same message for unknown email and wrong password;
 * - each failure slows the next answer (up to 2 s);
 * - after 5 failures an account is locked for 15 minutes; unknown emails follow exactly the same
 *   path (login_failures), so neither the lock nor the timing reveals whether an account exists;
 * - at most 20 attempts per IP in 10 minutes.
 */
export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 254);
  const parsed = loginInput.safeParse({ email, password: form.get("password") });
  if (!parsed.success) return { error: "Enter your email and password.", email };
  const sql = await getSql();
  const meta = await requestMeta();

  const ipLimit = await hitLimit(sql, "login_ip", meta.ip ?? "unknown");
  if (!ipLimit.allowed) {
    await audit(sql, null, "auth.login_throttled", { type: "ip", id: meta.ip }, { email }, meta.ip);
    return { error: `Too many sign-in attempts from this network. Try again in ${Math.ceil(ipLimit.retryAfterSeconds / 60)} minutes.`, email };
  }

  const user = (
    await sql.query<{ id: string; email: string; password_hash: string; active: boolean; failed_logins: number; locked_until: string | null; must_change_password: boolean; totp_enabled: boolean }>(
      "select id, email, password_hash, active, failed_logins, locked_until, must_change_password, totp_enabled from users where email = $1",
      [email],
    )
  )[0];

  // Accounts and unknown emails share one failure record shape and one code path, so the number of
  // attempts before the lock, the delays and the messages are identical: nothing reveals whether
  // an account exists. Unknown emails are tracked in login_failures.
  const ghost = user ? null : (await sql.query<{ failures: number; locked_until: string | null }>("select failures, locked_until from login_failures where email = $1", [email]))[0];
  const state = user ? { failures: user.failed_logins, locked_until: user.locked_until } : { failures: ghost?.failures ?? 0, locked_until: ghost?.locked_until ?? null };

  if (state.locked_until && Date.parse(state.locked_until) > Date.now()) {
    await audit(sql, null, "auth.login_locked", { type: "user", id: user?.id ?? email }, { email }, meta.ip);
    await pause(1000);
    return { error: LOCKED_MESSAGE, email };
  }

  const valid = await verifyPassword(parsed.data.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid || !user.active) {
    // Atomic increment: parallel guesses cannot read the same count and slip past the lock.
    const failures = user
      ? (await sql.query<{ n: number }>("update users set failed_logins = failed_logins + 1 where id = $1 returning failed_logins as n", [user.id]))[0]!.n
      : (
          await sql.query<{ n: number }>(
            `insert into login_failures (email, failures, updated_at) values ($1, 1, now())
             on conflict (email) do update set failures = login_failures.failures + 1, updated_at = now() returning failures as n`,
            [email],
          )
        )[0]!.n;
    const locked = failures >= LOCKOUT.attempts;
    if (locked) {
      const until = new Date(Date.now() + LOCKOUT.minutes * 60_000).toISOString();
      if (user) await sql.query("update users set failed_logins = 0, locked_until = $2 where id = $1", [user.id, until]);
      else await sql.query("update login_failures set failures = 0, locked_until = $2 where email = $1", [email, until]);
    }
    await pause(Math.min(2000, failures * 300));
    await audit(sql, null, locked ? "auth.account_locked" : "auth.login_failed", { type: "user", id: user?.id ?? email }, { email, reason: !user ? "unknown_account" : !user.active ? "inactive" : "wrong_password" }, meta.ip);
    return { error: locked ? LOCKED_MESSAGE : "Email or password is incorrect.", email };
  }

  await resetLimit(sql, "login_account", email);
  if (user.totp_enabled) {
    // The failure count is not reset here: wrong codes add to it, so the lock after 5 failures also
    // bounds guessing the second factor by someone who knows the password.
    await createSession(user.id, { mfaPending: true });
    await audit(sql, null, "auth.password_accepted", { type: "user", id: user.id }, { email, next_step: "two_factor" }, meta.ip);
    return { error: null, email, mfa: true };
  }
  await sql.query("update users set last_login_at = now(), failed_logins = 0, locked_until = null where id = $1", [user.id]);
  await createSession(user.id);
  await audit(sql, { id: user.id, email: user.email }, "auth.login_succeeded", { type: "user", id: user.id }, {}, meta.ip);
  redirect(user.must_change_password ? "/account/password?first=1" : safeNext(form.get("next")));
}

export type MfaState = { error: string | null; done?: boolean };

/**
 * Second step of sign-in: a code from the authenticator app or a recovery code. Wrong codes count
 * as failed sign-ins (5 lock the account for 15 minutes) and also end the pending session after 5.
 */
export async function verifyMfaAction(_prev: MfaState, form: FormData): Promise<MfaState> {
  const sql = await getSql();
  const meta = await requestMeta();
  const pending = await getPendingMfa();
  if (!pending) return { error: "The sign-in expired. Enter your email and password again.", done: true };
  const ipLimit = await hitLimit(sql, "login_ip", meta.ip ?? "unknown");
  if (!ipLimit.allowed) return { error: `Too many sign-in attempts from this network. Try again in ${Math.ceil(ipLimit.retryAfterSeconds / 60)} minutes.` };
  const code = String(form.get("code") ?? "").slice(0, 40);
  const factor = await verifySecondFactor(sql, { id: pending.user.id, totp_secret: pending.user.totp_secret, totp_last_step: pending.user.totp_last_step }, code);
  if (!factor) {
    const failures = (await sql.query<{ n: number }>("update users set failed_logins = failed_logins + 1 where id = $1 returning failed_logins as n", [pending.user.id]))[0]!.n;
    const attempts = (await sql.query<{ n: number }>("update sessions set mfa_attempts = mfa_attempts + 1 where id = $1 returning mfa_attempts as n", [pending.sessionId]))[0]?.n ?? 99;
    const locked = failures >= LOCKOUT.attempts;
    if (locked) await sql.query("update users set failed_logins = 0, locked_until = $2 where id = $1", [pending.user.id, new Date(Date.now() + LOCKOUT.minutes * 60_000).toISOString()]);
    await audit(sql, null, locked ? "auth.account_locked" : "auth.mfa_failed", { type: "user", id: pending.user.id }, { email: pending.user.email }, meta.ip);
    await pause(Math.min(2000, failures * 300));
    if (locked || attempts >= LOCKOUT.attempts) {
      await abandonMfa();
      return { error: locked ? LOCKED_MESSAGE : "Too many wrong codes. Sign in again.", done: true };
    }
    return { error: "That code is not valid. Check the time on your phone, or use a recovery code." };
  }
  await sql.query("update users set last_login_at = now(), failed_logins = 0, locked_until = null where id = $1", [pending.user.id]);
  await completeMfa(pending.sessionId);
  const who = { id: pending.user.id, email: pending.user.email };
  await audit(sql, who, "auth.login_succeeded", { type: "user", id: who.id }, { second_factor: factor }, meta.ip);
  if (factor === "recovery_code") await audit(sql, who, "user.recovery_code_used", { type: "user", id: who.id }, { remaining: pending.user.recovery_codes.length - 1 }, meta.ip);
  redirect(pending.user.must_change_password ? "/account/password?first=1" : safeNext(form.get("next")));
}

/** "Use a different account" on the code step. */
export async function cancelMfaAction(): Promise<void> {
  await abandonMfa();
  redirect("/login");
}

const codeInput = z.object({ code: z.string().trim().min(6, "Enter the code").max(40) }).strict();

/** Turns on two-factor sign-in once the first code from the app proves it is set up. Returns the recovery codes, shown once. */
export async function enableTwoFactorAction(input: unknown) {
  return action({ schema: codeInput, accountSetup: true }, input, async ({ sql, user }, d) => {
    const u = await loadFactorUser(sql, user.id);
    if (u.totp_enabled) throw new ActionError("Two-factor sign-in is already on.");
    if (!u.totp_secret || !/^\d{6}$/.test(d.code.replace(/\s/g, ""))) throw new ActionError("Enter the 6-digit code from your authenticator app.");
    if (!(await verifySecondFactor(sql, u, d.code))) throw new ActionError("That code is not valid. Check that the time on your phone is set automatically, then try the next code.");
    const codes = generateRecoveryCodes();
    await sql.query("update users set totp_enabled = true, recovery_codes = $2 where id = $1", [user.id, codes.map(hashRecoveryCode)]);
    await audit(sql, user, "user.mfa_enabled", { type: "user", id: user.id });
    return { recoveryCodes: codes };
  });
}

/** New recovery codes (the old ones stop working). Needs a current code. */
export async function regenerateRecoveryCodesAction(input: unknown) {
  return action({ schema: codeInput, accountSetup: true }, input, async ({ sql, user }, d) => {
    const u = await loadFactorUser(sql, user.id);
    if (!u.totp_enabled) throw new ActionError("Turn on two-factor sign-in first.");
    if (!(await verifySecondFactor(sql, u, d.code))) throw new ActionError("That code is not valid.");
    const codes = generateRecoveryCodes();
    await sql.query("update users set recovery_codes = $2 where id = $1", [user.id, codes.map(hashRecoveryCode)]);
    await audit(sql, user, "user.recovery_codes_regenerated", { type: "user", id: user.id });
    return { recoveryCodes: codes };
  });
}

/** Turns off two-factor sign-in (refused when the deployment requires it). Needs a current code. */
export async function disableTwoFactorAction(input: unknown) {
  return action({ schema: codeInput, accountSetup: true }, input, async ({ sql, user }, d) => {
    if (mustSetUpMfa({ ...user, totp_enabled: false })) throw new ActionError("This deployment requires two-factor sign-in for every user.");
    const u = await loadFactorUser(sql, user.id);
    if (!u.totp_enabled) throw new ActionError("Two-factor sign-in is already off.");
    if (!(await verifySecondFactor(sql, u, d.code))) throw new ActionError("That code is not valid.");
    await sql.query("update users set totp_enabled = false, totp_secret = null, totp_last_step = null, recovery_codes = '{}' where id = $1", [user.id]);
    await audit(sql, user, "user.mfa_disabled", { type: "user", id: user.id });
    return undefined;
  });
}

export async function logoutAction(): Promise<void> {
  const user = await getCurrentUser();
  await destroySession();
  if (user) await audit(await getSql(), user, "auth.logout", { type: "user", id: user.id });
  redirect("/login");
}

const passwordInput = z
  .object({
    current: z.string().min(1, "Enter your current password").max(200),
    next: z.string().min(12, "Use at least 12 characters").max(200),
    confirm: z.string().max(200),
  })
  .strict()
  .refine((d) => d.next === d.confirm, { path: ["confirm"], message: "The passwords do not match" })
  .refine((d) => d.next !== d.current, { path: ["next"], message: "Choose a password different from the current one" });

/** Changes your own password; clears the "must change" flag and signs out other sessions. */
export async function changePasswordAction(input: unknown) {
  return action({ schema: passwordInput, accountSetup: true }, input, async ({ sql, user }, d) => {
    const row = (await sql.query<{ password_hash: string }>("select password_hash from users where id = $1", [user.id]))[0]!;
    if (!(await verifyPassword(d.current, row.password_hash))) throw new ActionError("The current password is not correct.");
    await sql.query("update users set password_hash = $2, must_change_password = false where id = $1", [user.id, await hashPassword(d.next)]);
    const token = (await import("next/headers")).cookies;
    const current = (await token()).get("vigil_session")?.value;
    const { createHash } = await import("node:crypto");
    await sql.query("delete from sessions where user_id = $1 and token_hash <> $2", [user.id, current ? createHash("sha256").update(current).digest("hex") : ""]);
    await audit(sql, user, "user.password_changed", { type: "user", id: user.id });
    return undefined;
  });
}
