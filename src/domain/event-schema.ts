/**
 * NEXORA security event schema, copied from NEXORA (src/domain/security/events.ts, documented in
 * NEXORA docs/security-events.md). VIGIL validates every ingested event against it and fails loudly
 * on a mismatch: an event that does not parse is never stored silently, it becomes a
 * schema_mismatch integrity finding and stops the connector until the contract is fixed.
 *
 *   hash = SHA-256(prev_hash + canonicalJson(event without prev_hash and hash))
 *
 * Keep this file in sync with NEXORA. docs/event-schema.md lists the fields.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const SECURITY_CATEGORIES = ["authentication", "authorization", "configuration", "data_access", "integration", "automation", "system"] as const;
export const SECURITY_OUTCOMES = ["success", "failure", "unknown"] as const;
export const SECURITY_SEVERITIES = ["info", "low", "medium", "high"] as const;

export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];
export type SecurityOutcome = (typeof SECURITY_OUTCOMES)[number];
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

/** Every security action NEXORA emits, with its category, default outcome and severity. */
export const SECURITY_ACTIONS = {
  "auth.login_succeeded": { category: "authentication", outcome: "success", severity: "info" },
  "auth.login_failed": { category: "authentication", outcome: "failure", severity: "low" },
  "auth.demo_user_switched": { category: "authentication", outcome: "success", severity: "info" },
  "authz.denied": { category: "authorization", outcome: "failure", severity: "medium" },
  "validation.failed": { category: "data_access", outcome: "failure", severity: "low" },
  "rate_limit.exceeded": { category: "system", outcome: "failure", severity: "medium" },
  "record.owner_changed": { category: "data_access", outcome: "success", severity: "info" },
  "data.bulk_read": { category: "data_access", outcome: "success", severity: "medium" },
  "role.changed": { category: "configuration", outcome: "success", severity: "high" },
  "user.invited": { category: "configuration", outcome: "success", severity: "medium" },
  "user.disabled": { category: "configuration", outcome: "success", severity: "high" },
  "user.enabled": { category: "configuration", outcome: "success", severity: "medium" },
  "pipeline.stages_changed": { category: "configuration", outcome: "success", severity: "low" },
  "settings.changed": { category: "configuration", outcome: "success", severity: "medium" },
  "workflow.created": { category: "automation", outcome: "success", severity: "medium" },
  "workflow.updated": { category: "automation", outcome: "success", severity: "medium" },
  "workflow.enabled": { category: "automation", outcome: "success", severity: "medium" },
  "workflow.disabled": { category: "automation", outcome: "success", severity: "low" },
  "workflow.limit_exceeded": { category: "automation", outcome: "failure", severity: "high" },
  "cron.unauthorized": { category: "system", outcome: "failure", severity: "high" },
  "demo.reset": { category: "system", outcome: "success", severity: "medium" },
  "system.heartbeat": { category: "system", outcome: "success", severity: "info" },
  // Phase 4: API keys, public API, integrations
  "api_key.created": { category: "configuration", outcome: "success", severity: "medium" },
  "api_key.revoked": { category: "configuration", outcome: "success", severity: "medium" },
  "api_key.used_after_revoke": { category: "authentication", outcome: "failure", severity: "high" },
  "api.auth_failed": { category: "authentication", outcome: "failure", severity: "medium" },
  "api.scope_denied": { category: "authorization", outcome: "failure", severity: "medium" },
  "integration.changed": { category: "configuration", outcome: "success", severity: "medium" },
  "integration.webhook_sent": { category: "integration", outcome: "success", severity: "info" },
  "webhook.signature_invalid": { category: "integration", outcome: "failure", severity: "high" },
  "security.ssrf_blocked": { category: "integration", outcome: "failure", severity: "high" },
} as const satisfies Record<string, { category: SecurityCategory; outcome: SecurityOutcome; severity: SecuritySeverity }>;

export type SecurityAction = keyof typeof SECURITY_ACTIONS;
export const SECURITY_ACTION_NAMES = Object.keys(SECURITY_ACTIONS) as SecurityAction[];

export function isSecurityAction(value: string): value is SecurityAction {
  return value in SECURITY_ACTIONS;
}

export const securityActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), user_id: z.uuid(), role: z.string().max(32) }).strict(),
  z.object({ type: z.literal("api_key"), api_key_id: z.uuid() }).strict(),
  z.object({ type: z.literal("service"), name: z.string().max(64) }).strict(),
  z.object({ type: z.literal("anonymous") }).strict(),
]);
export type SecurityActor = z.infer<typeof securityActorSchema>;

export const securityEventSchema = z
  .object({
    event_id: z.uuid(),
    organization_id: z.uuid(),
    sequence: z.number().int().min(1),
    occurred_at: z.iso.datetime({ offset: true }),
    category: z.enum(SECURITY_CATEGORIES),
    action: z.enum(SECURITY_ACTION_NAMES as [SecurityAction, ...SecurityAction[]]),
    outcome: z.enum(SECURITY_OUTCOMES),
    severity: z.enum(SECURITY_SEVERITIES),
    actor: securityActorSchema,
    source: z.object({ ip: z.string().max(64).nullable(), user_agent: z.string().max(512).nullable(), request_id: z.string().max(64).nullable() }).strict(),
    target: z.object({ type: z.string().max(64).nullable(), id: z.string().max(120).nullable() }).strict(),
    metadata: z.record(z.string(), z.unknown()),
    prev_hash: z.string().regex(/^[a-f0-9]{64}$/),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SecurityEvent = z.infer<typeof securityEventSchema>;

export const GENESIS_HASH = "0".repeat(64);

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_KEY = /(secret|password|passwd|token|api[_-]?key|authorization|cookie|signature|credential|private)/i;
const MAX_STRING = 500;

/**
 * Removes secrets and oversized values from metadata: keys that look secret are replaced
 * with "[redacted]", long strings are truncated, nesting is capped. Full request bodies
 * must never be passed in the first place.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashEvent(prevHash: string, event: Omit<SecurityEvent, "hash" | "prev_hash">): string {
  return createHash("sha256").update(prevHash + canonicalJson(event)).digest("hex");
}

export type SecurityEventDraft = {
  event_id: string;
  organization_id: string;
  occurred_at: string;
  action: SecurityAction;
  outcome?: SecurityOutcome;
  severity?: SecuritySeverity;
  actor: SecurityActor;
  source: SecurityEvent["source"];
  target?: Partial<SecurityEvent["target"]>;
  metadata?: Record<string, unknown>;
};

/** Seals a draft onto the chain after `previous` (null for the first event of an organization). */
export function sealSecurityEvent(draft: SecurityEventDraft, previous: Pick<SecurityEvent, "sequence" | "hash"> | null): SecurityEvent {
  const spec = SECURITY_ACTIONS[draft.action];
  const body: Omit<SecurityEvent, "hash" | "prev_hash"> = {
    event_id: draft.event_id,
    organization_id: draft.organization_id,
    sequence: (previous?.sequence ?? 0) + 1,
    occurred_at: draft.occurred_at,
    category: spec.category,
    action: draft.action,
    outcome: draft.outcome ?? spec.outcome,
    severity: draft.severity ?? spec.severity,
    actor: draft.actor,
    source: draft.source,
    target: { type: draft.target?.type ?? null, id: draft.target?.id ?? null },
    metadata: redact(draft.metadata ?? {}) as Record<string, unknown>,
  };
  const prev_hash = previous?.hash ?? GENESIS_HASH;
  return { ...body, prev_hash, hash: hashEvent(prev_hash, body) };
}

export type ChainVerification =
  | { ok: true; checked: number; lastSequence: number; lastHash: string }
  | { ok: false; checked: number; failedAt: number; reason: "sequence_gap" | "prev_hash_mismatch" | "hash_mismatch" | "schema_invalid"; detail: string };

/**
 * Verifies one organization's chain. Detects modified events (hash mismatch), deleted or
 * inserted events (sequence gap or prev_hash mismatch) and malformed rows.
 */
export function verifySecurityLogChain(events: SecurityEvent[]): ChainVerification {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  let prevHash = GENESIS_HASH;
  let expected = 1;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (!securityEventSchema.safeParse(e).success) return { ok: false, checked: i, failedAt: e.sequence, reason: "schema_invalid", detail: `Event ${e.sequence} does not match the schema.` };
    if (e.sequence !== expected) return { ok: false, checked: i, failedAt: e.sequence, reason: "sequence_gap", detail: `Expected sequence ${expected}, found ${e.sequence}.` };
    if (e.prev_hash !== prevHash) return { ok: false, checked: i, failedAt: e.sequence, reason: "prev_hash_mismatch", detail: `Event ${e.sequence} does not point at the previous event.` };
    const { hash, prev_hash, ...body } = e;
    void prev_hash;
    if (hashEvent(prevHash, body) !== hash) return { ok: false, checked: i, failedAt: e.sequence, reason: "hash_mismatch", detail: `Event ${e.sequence} was modified after it was written.` };
    prevHash = hash;
    expected += 1;
  }
  return { ok: true, checked: sorted.length, lastSequence: expected - 1, lastHash: prevHash };
}
