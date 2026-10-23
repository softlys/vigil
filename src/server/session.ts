import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";
import { db as getSql } from "./db";
import { clientIp } from "@/lib/client-ip";
import { getConfig } from "@/lib/config";

/**
 * Sessions: a random 256-bit token in an httpOnly, SameSite=Strict cookie; only its SHA-256 is
 * stored. Sessions expire after 12 hours and end when the user is deactivated.
 *
 * With two-factor sign-in, the password creates a *pending* session in a separate cookie: it grants
 * nothing, lasts 5 minutes, and becomes the real session once the code is verified.
 */
export const SESSION_COOKIE = "vigil_session";
export const MFA_COOKIE = "vigil_mfa";
const SESSION_HOURS = 12;
const MFA_PENDING_MINUTES = 5;

export type CurrentUser = { id: string; email: string; name: string; role: "analyst" | "admin"; must_change_password?: boolean; totp_enabled?: boolean };

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return { ip: clientIp(h.get("x-forwarded-for"), h.get("x-real-ip")), userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
}

const cookieOptions = (expires: Date) => ({ httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/", expires });

/** A full session, or with `mfaPending` one that only allows entering the second factor. */
export async function createSession(userId: string, options: { mfaPending?: boolean } = {}): Promise<void> {
  const sql = await getSql();
  const token = randomBytes(32).toString("base64url");
  const meta = await requestMeta();
  const expires = new Date(Date.now() + (options.mfaPending ? MFA_PENDING_MINUTES * 60_000 : SESSION_HOURS * 3_600_000));
  await sql.query("insert into sessions (id, token_hash, user_id, expires_at, ip, user_agent, mfa_pending) values ($1, $2, $3, $4, $5, $6, $7)", [
    randomUUID(),
    tokenHash(token),
    userId,
    expires.toISOString(),
    meta.ip,
    meta.userAgent,
    Boolean(options.mfaPending),
  ]);
  (await cookies()).set(options.mfaPending ? MFA_COOKIE : SESSION_COOKIE, token, cookieOptions(expires));
}

export type PendingMfa = { sessionId: string; attempts: number; user: { id: string; email: string; totp_secret: string; totp_last_step: number | null; recovery_codes: string[]; must_change_password: boolean } };

/** The pending second-factor session of this browser, if it is still valid. */
export async function getPendingMfa(): Promise<PendingMfa | null> {
  const token = (await cookies()).get(MFA_COOKIE)?.value;
  if (!token) return null;
  const row = (
    await (await getSql()).query<PendingMfa["user"] & { session_id: string; attempts: number }>(
      `select s.id as session_id, s.mfa_attempts as attempts, u.id, u.email, u.totp_secret, u.totp_last_step, u.recovery_codes, u.must_change_password
         from sessions s join users u on u.id = s.user_id
        where s.token_hash = $1 and s.mfa_pending and s.expires_at > now() and u.active and u.totp_enabled`,
      [tokenHash(token)],
    )
  )[0];
  if (!row) return null;
  const { session_id, attempts, ...user } = row;
  return { sessionId: session_id, attempts, user: { ...user, totp_last_step: user.totp_last_step === null ? null : Number(user.totp_last_step) } };
}

/** Turns the pending session into a full one (the same token moves to the session cookie). */
export async function completeMfa(sessionId: string): Promise<void> {
  const store = await cookies();
  const token = store.get(MFA_COOKIE)?.value;
  if (!token) return;
  const expires = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  await (await getSql()).query("update sessions set mfa_pending = false, expires_at = $2 where id = $1 and token_hash = $3", [sessionId, expires.toISOString(), tokenHash(token)]);
  store.delete(MFA_COOKIE);
  store.set(SESSION_COOKIE, token, cookieOptions(expires));
}

export async function abandonMfa(): Promise<void> {
  const store = await cookies();
  const token = store.get(MFA_COOKIE)?.value;
  if (token) await (await getSql()).query("delete from sessions where token_hash = $1 and mfa_pending", [tokenHash(token)]);
  store.delete(MFA_COOKIE);
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await (await getSql()).query("delete from sessions where token_hash = $1", [tokenHash(token)]);
  store.delete(SESSION_COOKIE);
}

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const sql = await getSql();
  const row = (
    await sql.query<CurrentUser>(
      "select u.id, u.email, u.name, u.role, u.must_change_password, u.totp_enabled from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now() and not s.mfa_pending and u.active",
      [tokenHash(token)],
    )
  )[0];
  return row ?? null;
});

/** With VIGIL_REQUIRE_MFA (default in production), a user without a second factor can only set one up. */
export const mustSetUpMfa = (user: CurrentUser) => getConfig().requireMfa && !user.totp_enabled;

/** Pages and actions: every route requires a session. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // An initial or reset password must be replaced before anything else.
  if (user.must_change_password) redirect("/account/password?first=1");
  if (mustSetUpMfa(user)) redirect("/account/two-factor?setup=1");
  return user;
}

/** Admin-only pages and actions (response approval, rules, users, settings). */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "admin") forbidden();
  return user;
}
