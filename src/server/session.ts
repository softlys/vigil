import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";
import { db as getSql } from "./db";
import { clientIp } from "@/lib/client-ip";

/**
 * Sessions: a random 256-bit token in an httpOnly, SameSite=Strict cookie; only its SHA-256 is
 * stored. Sessions expire after 12 hours and end when the user is deactivated.
 */
export const SESSION_COOKIE = "vigil_session";
const SESSION_HOURS = 12;

export type CurrentUser = { id: string; email: string; name: string; role: "analyst" | "admin"; must_change_password?: boolean };

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return { ip: clientIp(h.get("x-forwarded-for"), h.get("x-real-ip")), userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
}

export async function createSession(userId: string): Promise<void> {
  const sql = await getSql();
  const token = randomBytes(32).toString("base64url");
  const meta = await requestMeta();
  const expires = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  await sql.query("insert into sessions (id, token_hash, user_id, expires_at, ip, user_agent) values ($1, $2, $3, $4, $5, $6)", [
    randomUUID(),
    tokenHash(token),
    userId,
    expires.toISOString(),
    meta.ip,
    meta.userAgent,
  ]);
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", expires });
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
      "select u.id, u.email, u.name, u.role, u.must_change_password from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now() and u.active",
      [tokenHash(token)],
    )
  )[0];
  return row ?? null;
});

/** Pages and actions: every route requires a session. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // An initial or reset password must be replaced before anything else.
  if (user.must_change_password) redirect("/account/password?first=1");
  return user;
}

/** Admin-only pages and actions (response approval, rules, users, settings). */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "admin") forbidden();
  return user;
}
