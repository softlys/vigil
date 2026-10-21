"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { db as getSql } from "../db";
import { DUMMY_HASH, hashPassword, verifyPassword } from "@/lib/passwords";
import { hitLimit, resetLimit } from "@/lib/rate-limit";
import { action, ActionError } from "../action";
import { createSession, destroySession, getCurrentUser, requestMeta } from "../session";

const loginInput = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export type LoginState = { error: string | null; email: string };

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
 * - after 5 failures an account is locked for 15 minutes (unknown emails are throttled the same way,
 *   so the lock message does not reveal whether an account exists);
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
    await sql.query<{ id: string; email: string; password_hash: string; active: boolean; failed_logins: number; locked_until: string | null; must_change_password: boolean }>(
      "select id, email, password_hash, active, failed_logins, locked_until, must_change_password from users where email = $1",
      [email],
    )
  )[0];

  if (user?.locked_until && Date.parse(user.locked_until) > Date.now()) {
    await audit(sql, null, "auth.login_locked", { type: "user", id: user.id }, { email }, meta.ip);
    await pause(1000);
    return { error: LOCKED_MESSAGE, email };
  }
  if (!user) {
    // Unknown accounts get the same lock behavior through the per-email limiter.
    const accountLimit = await hitLimit(sql, "login_account", email);
    if (!accountLimit.allowed) return { error: LOCKED_MESSAGE, email };
  }

  const valid = await verifyPassword(parsed.data.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid || !user.active) {
    let locked = false;
    if (user) {
      const failures = user.failed_logins + 1;
      locked = failures >= LOCKOUT.attempts;
      await sql.query("update users set failed_logins = $2, locked_until = $3 where id = $1", [
        user.id,
        locked ? 0 : failures,
        locked ? new Date(Date.now() + LOCKOUT.minutes * 60_000).toISOString() : null,
      ]);
      await pause(Math.min(2000, failures * 300));
    } else {
      await pause(600);
    }
    await audit(sql, null, locked ? "auth.account_locked" : "auth.login_failed", { type: "user", id: user?.id ?? email }, { email, reason: !user ? "unknown_account" : !user.active ? "inactive" : "wrong_password" }, meta.ip);
    return { error: locked ? LOCKED_MESSAGE : "Email or password is incorrect.", email };
  }

  await resetLimit(sql, "login_account", email);
  await sql.query("update users set last_login_at = now(), failed_logins = 0, locked_until = null where id = $1", [user.id]);
  await createSession(user.id);
  await audit(sql, { id: user.id, email: user.email }, "auth.login_succeeded", { type: "user", id: user.id }, {}, meta.ip);
  redirect(user.must_change_password ? "/account/password?first=1" : safeNext(form.get("next")));
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
  return action({ schema: passwordInput }, input, async ({ sql, user }, d) => {
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
