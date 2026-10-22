import { createHmac, timingSafeEqual } from "node:crypto";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/client-ip";
import { getConfig } from "@/lib/config";
import { getSql } from "@/lib/db";
import { ingestEvents, parseEvents, SchemaMismatchError } from "@/lib/ingest";
import { hitLimit } from "@/lib/rate-limit";

/**
 * Optional push receiver for NEXORA security events: POST a JSON array of events, or
 * `{ "events": [...] }` (also inside a NEXORA webhook envelope's `data`), signed like NEXORA's
 * outbound webhooks: X-Nexora-Signature: t=<unix>,v1=hex(HMAC-SHA256(VIGIL_INGEST_SECRET, "t.body")).
 * Disabled unless VIGIL_INGEST_SECRET is set. Events go through the same validation and chain checks
 * as polling, and duplicates (already polled) are ignored.
 */
const MAX_BODY = 1024 * 1024;

function verify(secret: string, header: string | null, body: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=").map((x) => x.trim())));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > 300 || !/^[a-f0-9]{64}$/.test(parts.v1 ?? "")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"), "hex");
  const given = Buffer.from(parts.v1!, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function POST(request: Request) {
  const secret = getConfig().ingestSecret;
  if (!secret) return Response.json({ error: "The push receiver is disabled. Set VIGIL_INGEST_SECRET." }, { status: 503 });
  const sql = await getSql();
  const ip = clientIp(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip")) ?? "unknown";
  const limit = await hitLimit(sql, "ingest", ip);
  if (!limit.allowed) return Response.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });

  const body = await request.text();
  if (body.length > MAX_BODY) return Response.json({ error: "Body too large (1 MB)" }, { status: 413 });
  if (!verify(secret, request.headers.get("x-nexora-signature"), body)) {
    await audit(sql, null, "ingest.signature_invalid", { type: "ip", id: ip }, {}, ip);
    return Response.json({ error: "Invalid or missing X-Nexora-Signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const p = payload as { events?: unknown; data?: { events?: unknown } };
  const raw = Array.isArray(payload) ? payload : Array.isArray(p.events) ? p.events : Array.isArray(p.data?.events) ? p.data!.events : null;
  if (!raw) return Response.json({ error: "Expected an array of events or { events: [...] }" }, { status: 400 });
  try {
    const result = await ingestEvents(sql, "nexora", parseEvents(raw as unknown[]));
    return Response.json({ stored: result.stored, duplicates: result.duplicates, findings: result.findings.length });
  } catch (error) {
    if (error instanceof SchemaMismatchError) return Response.json({ error: error.message, details: error.issues }, { status: 422 });
    throw error;
  }
}
