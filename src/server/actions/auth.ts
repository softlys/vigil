"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { db as getSql } from "../db";
import { DUMMY_HASH, verifyPassword } from "@/lib/passwords";
import { hitLimit, resetLimit } from "@/lib/rate-limit";
import { createSession, destroySession, getCurrentUser, requestMeta } from "../session";

const loginInput = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export type LoginState = { error: string | null };

/** Sign-in with per-IP and per-account rate limits. The same message for unknown email and wrong password. */
export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = loginInput.safeParse({ email: String(form.get("email") ?? "").trim().toLowerCase(), password: form.get("password") });
  if (!parsed.success) return { error: "Enter your email and password." };
  const sql = await getSql();
  const meta = await requestMeta();
  const ipLimit = await hitLimit(sql, "login_ip", meta.ip ?? "unknown");
  const accountLimit = await hitLimit(sql, "login_account", parsed.data.email);
  if (!ipLimit.allowed || !accountLimit.allowed) {
    await audit(sql, null, "auth.login_throttled", { type: "user", id: parsed.data.email }, {}, meta.ip);
    return { error: `Too many attempts. Try again in ${Math.ceil(Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds) / 60)} minutes.` };
  }
  const user = (await sql.query<{ id: string; email: string; password_hash: string; active: boolean }>("select id, email, password_hash, active from users where email = $1", [parsed.data.email]))[0];
  const valid = await verifyPassword(parsed.data.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid || !user.active) {
    await audit(sql, null, "auth.login_failed", { type: "user", id: parsed.data.email }, { reason: !user ? "unknown_account" : !user.active ? "inactive" : "wrong_password" }, meta.ip);
    return { error: "Email or password is incorrect." };
  }
  await resetLimit(sql, "login_account", parsed.data.email);
  await sql.query("update users set last_login_at = now() where id = $1", [user.id]);
  await createSession(user.id);
  await audit(sql, { id: user.id, email: user.email }, "auth.login_succeeded", { type: "user", id: user.id }, {}, meta.ip);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const user = await getCurrentUser();
  await destroySession();
  if (user) await audit(await getSql(), user, "auth.logout", { type: "user", id: user.id });
  redirect("/login");
}
