import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), as used by
 * Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden and others.
 */
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const totpStep = (now: number) => Math.floor(now / 1000 / TOTP_STEP_SECONDS);

export function totpCode(secret: string, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, "0");
}

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the
 * matching step, or null. A step at or before `lastStep` is refused, so a code works only once.
 */
export function verifyTotp(secret: string, code: string, now: number, lastStep: number | null): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = totpCode(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return step;
  }
  return null;
}

/** otpauth:// link for the QR code. */
export function otpauthUri(secret: string, account: string, issuer = "VIGIL"): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/** One-time recovery codes ("abcd-efgh-ijkl"); only their SHA-256 is stored. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    base32Encode(randomBytes(8))
      .slice(0, 12)
      .toLowerCase()
      .replace(/(.{4})(?=.)/g, "$1-"),
  );
}

export const hashRecoveryCode = (code: string) =>
  createHash("sha256")
    .update(code.trim().toLowerCase().replace(/[\s-]/g, ""))
    .digest("hex");

export const looksLikeRecoveryCode = (code: string) => /^[a-z2-7]{12}$/.test(code.trim().toLowerCase().replace(/[\s-]/g, ""));
