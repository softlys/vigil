import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, totpCode, totpStep, verifyTotp } from "@/lib/totp";
import { verifySecondFactor } from "@/server/two-factor";
import { freshDb } from "./helpers";

// RFC 6238 appendix B, SHA-1 key "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, code] of vectors) expect(totpCode(RFC_SECRET, Math.floor(t / 30), 8)).toBe(code);
  });

  it("round-trips base32 and makes 160-bit secrets", () => {
    const bytes = Buffer.from("any bytes \u0000ÿ here");
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it("accepts one step of clock drift, refuses older codes and replays", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, totpCode(secret, step), now, null)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull();
    expect(verifyTotp(secret, "12345", now, null)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now, null)).toBeNull();
  });

  it("builds an otpauth link for the QR code", () => {
    expect(otpauthUri("ABC", "ana@example.com")).toBe("otpauth://totp/VIGIL%3Aana%40example.com?secret=ABC&issuer=VIGIL&algorithm=SHA1&digits=6&period=30");
  });

  it("requires two-factor sign-in in production mode by default", () => {
    const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
    expect(getConfig(env({ VIGIL_MODE: "production" })).requireMfa).toBe(true);
    expect(getConfig(env({ VIGIL_MODE: "production", VIGIL_REQUIRE_MFA: "0" })).requireMfa).toBe(false);
    expect(getConfig(env({ VIGIL_MODE: "demo" })).requireMfa).toBe(false);
    expect(getConfig(env({ VIGIL_MODE: "demo", VIGIL_REQUIRE_MFA: "1" })).requireMfa).toBe(true);
  });
});

describe("second factor against the database", () => {
  async function userWithMfa() {
    const sql = await freshDb();
    const id = randomUUID();
    const secret = generateTotpSecret();
    const codes = generateRecoveryCodes();
    await sql.query("insert into users (id, email, name, role, password_hash, totp_secret, totp_enabled, recovery_codes) values ($1, $2, 'Ana', 'analyst', 'x', $3, true, $4)", [id, `${id}@example.com`, secret, codes.map(hashRecoveryCode)]);
    return { sql, user: { id, totp_secret: secret, totp_last_step: null as number | null }, codes };
  }

  it("accepts a code once: the same code cannot be used again", async () => {
    const { sql, user, codes } = await userWithMfa();
    const now = Date.now();
    const code = totpCode(user.totp_secret, totpStep(now));
    expect(await verifySecondFactor(sql, user, code, now)).toBe("totp");
    // A stale view of the user (last step not yet seen) still cannot replay it: the update is conditional.
    expect(await verifySecondFactor(sql, user, code, now)).toBeNull();
    expect(codes).toHaveLength(8);
    await sql.close();
  });

  it("uses each recovery code once, in any format", async () => {
    const { sql, user, codes } = await userWithMfa();
    expect(codes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(await verifySecondFactor(sql, user, codes[0]!.toUpperCase().replace(/-/g, " "))).toBe("recovery_code");
    expect(await verifySecondFactor(sql, user, codes[0]!)).toBeNull();
    const left = (await sql.query<{ n: number }>("select cardinality(recovery_codes) as n from users where id = $1", [user.id]))[0]!.n;
    expect(Number(left)).toBe(7);
    expect(await verifySecondFactor(sql, user, "aaaa-bbbb-cccc")).toBeNull();
    await sql.close();
  });

  it("refuses everything without a secret", async () => {
    const { sql, user } = await userWithMfa();
    expect(await verifySecondFactor(sql, { ...user, totp_secret: null }, "123456")).toBeNull();
    await sql.close();
  });
});
