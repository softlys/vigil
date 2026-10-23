import "server-only";
import type { Sql } from "@/lib/db";
import { hashRecoveryCode, looksLikeRecoveryCode, verifyTotp } from "@/lib/totp";

type FactorUser = { id: string; totp_secret: string | null; totp_last_step: number | null };

/**
 * Checks a second factor: a 6-digit code from the authenticator app, or one of the recovery codes.
 * Both are single-use: the TOTP step is recorded and a recovery code is removed, each with a
 * conditional update, so two parallel requests cannot use the same code.
 */
export async function verifySecondFactor(sql: Sql, user: FactorUser, code: string, now = Date.now()): Promise<"totp" | "recovery_code" | null> {
  if (!user.totp_secret) return null;
  if (looksLikeRecoveryCode(code)) {
    const used = await sql.query("update users set recovery_codes = array_remove(recovery_codes, $2) where id = $1 and $2 = any(recovery_codes) returning id", [user.id, hashRecoveryCode(code)]);
    return used.length ? "recovery_code" : null;
  }
  const step = verifyTotp(user.totp_secret, code, now, user.totp_last_step);
  if (step === null) return null;
  const claimed = await sql.query("update users set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2) returning id", [user.id, step]);
  return claimed.length ? "totp" : null;
}

export async function loadFactorUser(sql: Sql, id: string): Promise<FactorUser & { totp_enabled: boolean; email: string; recovery_codes: string[] }> {
  const row = (
    await sql.query<FactorUser & { totp_enabled: boolean; email: string; recovery_codes: string[] }>("select id, email, totp_secret, totp_last_step, totp_enabled, recovery_codes from users where id = $1", [id])
  )[0]!;
  return { ...row, totp_last_step: row.totp_last_step === null ? null : Number(row.totp_last_step) };
}
