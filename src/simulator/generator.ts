/**
 * Event simulator: a baseline of normal NEXORA activity plus scripted attack scenarios, written in
 * the exact NEXORA security event schema with a valid hash chain (so ingestion verifies it like real
 * events). Everything it produces is stored with source "simulator" and labelled Simulated in the UI.
 */
import { randomUUID } from "node:crypto";
import { sealSecurityEvent, type SecurityAction, type SecurityActor, type SecurityEvent, type SecurityEventDraft } from "@/domain/event-schema";
import { API_KEYS, ATTACK_AGENT, ATTACKER_IPS, byName, KNOWN_WEBHOOK_DOMAINS, SIM_ORG_ID, USER_AGENT, USERS, WORKFLOW_IDS, type SimUser } from "./world";

export type Draft = Omit<SecurityEventDraft, "event_id" | "organization_id"> & { tamper?: boolean; skipBefore?: number };

export type Rng = () => number;
/** Small deterministic PRNG (mulberry32) so tests and backfills are reproducible. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: Rng, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

const userActor = (u: SimUser): SecurityActor => ({ type: "user", user_id: u.id, role: u.role });
const service: SecurityActor = { type: "service", name: "nexora" };
const anonymous: SecurityActor = { type: "anonymous" };
const src = (ip: string | null, ua: string | null = USER_AGENT) => ({ ip, user_agent: ua, request_id: randomUUID() });

function draft(action: SecurityAction, at: Date, actor: SecurityActor, source: SecurityEventDraft["source"], target: SecurityEventDraft["target"] = undefined, metadata: Record<string, unknown> = {}, extra: Partial<Draft> = {}): Draft {
  return { action, occurred_at: at.toISOString(), actor, source, target, metadata, ...extra };
}

const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

/** Seals drafts onto the chain after `previous`. `tamper` breaks the hash, `skipBefore` leaves a sequence gap. */
export function seal(drafts: Draft[], previous: { sequence: number; hash: string } | null): SecurityEvent[] {
  const out: SecurityEvent[] = [];
  let prev = previous;
  for (const d of drafts) {
    const { tamper, skipBefore, ...body } = d;
    const base = prev && skipBefore ? { sequence: prev.sequence + skipBefore, hash: prev.hash } : prev;
    const event = sealSecurityEvent({ ...body, event_id: randomUUID(), organization_id: SIM_ORG_ID }, base);
    // A tampered event is modified after sealing: its stored hash no longer matches its content.
    const stored = tamper ? { ...event, metadata: { ...event.metadata, records: 3, note: "edited after write" } } : event;
    out.push(stored);
    prev = { sequence: event.sequence, hash: event.hash };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 5 * 60_000;

function isWorkingHours(d: Date): boolean {
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day !== 0 && day !== 6 && h >= 7 && h < 19;
}

/**
 * Normal activity between `from` (exclusive) and `to`: heartbeats every 5 minutes, sign-ins during
 * working hours (occasionally after one typo), webhooks to known integrations, daily exports by
 * managers, rare settings and workflow edits, a few denied links, and integration API errors from
 * the integrations' usual IPs.
 */
export function baseline(from: Date, to: Date, r: Rng, lastHeartbeat: Date | null): Draft[] {
  const out: Draft[] = [];
  let hb = lastHeartbeat ? lastHeartbeat.getTime() + HEARTBEAT_MS : Math.ceil(from.getTime() / HEARTBEAT_MS) * HEARTBEAT_MS;
  for (; hb <= to.getTime(); hb += HEARTBEAT_MS) {
    if (hb <= from.getTime()) continue;
    out.push(draft("system.heartbeat", new Date(hb), service, src(null, null), undefined, { component: "scheduler", date_events: Math.floor(r() * 3), resumed: 0 }));
  }
  // Activity per 10-minute slot.
  const SLOT = 10 * 60_000;
  for (let t = Math.floor(from.getTime() / SLOT) * SLOT + SLOT; t <= to.getTime(); t += SLOT) {
    const slot = new Date(t);
    const busy = isWorkingHours(slot);
    const jitter = () => at(slot, -Math.floor(r() * 590));
    if (busy && r() < 0.55) {
      const u = pick(r, USERS);
      const when = jitter();
      if (r() < 0.12) out.push(draft("auth.login_failed", when, anonymous, src(u.ip), { type: "account", id: u.id }, { account_key: u.accountKey, known_account: true, reason: "invalid_credentials" }));
      out.push(draft("auth.login_succeeded", at(when, 20), anonymous, src(u.ip), { type: "account", id: u.id }, { account_key: u.accountKey, user_id: u.id }));
    }
    if (busy && r() < 0.35) {
      out.push(draft("integration.webhook_sent", jitter(), service, src(null, null), { type: "integration", id: WORKFLOW_IDS[0]! }, { provider: "make", domain: pick(r, KNOWN_WEBHOOK_DOMAINS), event_type: "lead.created", attempt: 1, status_code: 200, outcome: "success" }));
    }
    if (busy && r() < 0.03) {
      const u = pick(r, USERS.filter((x) => x.role === "sales_rep"));
      out.push(draft("authz.denied", jitter(), userActor(u), src(u.ip), { type: "deal", id: randomUUID() }, { action: "view", resource: "deal", target_id: null, reason: "not_visible" }));
    }
    if (busy && r() < 0.015) {
      const admin = byName("Olivia");
      out.push(draft("settings.changed", jitter(), userActor(admin), src(admin.ip), { type: "organization", id: SIM_ORG_ID }, { fields: ["locale"] }));
    }
    if (busy && r() < 0.01) {
      const m = byName("Marcus");
      out.push(draft("workflow.updated", jitter(), userActor(m), src(m.ip), { type: "workflow", id: pick(r, WORKFLOW_IDS) }, { version: 2 + Math.floor(r() * 5), fields: ["definition"] }));
    }
    if (busy && r() < 0.02) {
      const k = pick(r, API_KEYS);
      out.push(draft("api.scope_denied", jitter(), { type: "api_key", api_key_id: k.id }, src(k.ip, "Make/production"), { type: "api_key", id: k.id }, { required: "records:read", scopes: ["leads:write"], path: "/companies" }));
    }
    // Daily export by each manager around 09:00 UTC on weekdays: the baseline for VGL-011.
    if (busy && slot.getUTCHours() === 9 && slot.getUTCMinutes() === 0) {
      for (const m of USERS.filter((x) => x.role === "manager")) {
        out.push(draft("data.bulk_read", at(slot, -120 - Math.floor(r() * 300)), userActor(m), src(m.ip), undefined, { resource: "company", records: 300 + Math.floor(r() * 160), threshold: 300, window_seconds: 300 }));
      }
    }
  }
  return out.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

/**
 * Events that establish what "normal" looks like before the first baseline slot: every integration
 * domain has been used once and every API key has been seen from its usual IP, so new-value rules
 * learn them instead of alerting on the first normal event.
 */
export function bootstrap(t: Date): Draft[] {
  return [
    ...KNOWN_WEBHOOK_DOMAINS.map((domain, i) =>
      draft("integration.webhook_sent", at(t, i), service, src(null, null), { type: "integration", id: WORKFLOW_IDS[0]! }, { provider: "make", domain, event_type: "lead.created", attempt: 1, status_code: 200, outcome: "success" }),
    ),
    ...API_KEYS.map((k, i) => draft("api.scope_denied", at(t, 10 + i), { type: "api_key", api_key_id: k.id }, src(k.ip, "Make/production"), { type: "api_key", id: k.id }, { required: "records:read", scopes: ["leads:write"], path: "/companies" })),
  ];
}

/** Several normal daily exports by the manager, so VGL-011 has a baseline before the exfiltration scenario. */
export function exportHistory(t0: Date, days = 5): Draft[] {
  const m = byName("Marcus");
  return Array.from({ length: days }, (_, i) =>
    draft("data.bulk_read", at(t0, -(days - i) * 86_400), userActor(m), src(m.ip), undefined, { resource: "company", records: 320 + i * 25, threshold: 300, window_seconds: 300 }),
  );
}

// ---------------------------------------------------------------------------
// Attack scenarios
// ---------------------------------------------------------------------------

export const SCENARIOS = [
  { key: "brute_force", title: "Brute force against one account", rules: ["VGL-001"] },
  { key: "password_spraying", title: "Password spraying from one IP", rules: ["VGL-002"] },
  { key: "success_after_failures", title: "Successful sign-in after failures", rules: ["VGL-003"] },
  { key: "idor_probing", title: "IDOR probing of record ids", rules: ["VGL-004"] },
  { key: "privilege_escalation", title: "Privilege escalation to admin", rules: ["VGL-006", "VGL-005"] },
  { key: "api_key_abuse", title: "API key abuse", rules: ["VGL-007", "VGL-008", "VGL-009", "VGL-010"] },
  { key: "data_exfiltration", title: "Bulk read above baseline", rules: ["VGL-011"] },
  { key: "automation_tampering", title: "Workflow change then webhook to a new domain", rules: ["VGL-012"] },
  { key: "ssrf_attempt", title: "SSRF attempt", rules: ["VGL-013"] },
  { key: "forgery", title: "Forged cron and webhook calls", rules: ["VGL-014", "VGL-010"] },
  { key: "log_tampering", title: "Log tampering (chain break and gap)", rules: ["VGL-015"] },
] as const;
export type ScenarioKey = (typeof SCENARIOS)[number]["key"];

/** Builds the events of one scenario starting at `t0`. VGL-005 additionally needs `t0` outside working hours. */
export function scenario(key: ScenarioKey, t0: Date, r: Rng): Draft[] {
  const ip = (i: number) => ATTACKER_IPS[i % ATTACKER_IPS.length]!;
  const evil = src(ip(0), ATTACK_AGENT);
  switch (key) {
    case "brute_force": {
      const victim = byName("Sofia");
      return Array.from({ length: 12 }, (_, i) =>
        draft("auth.login_failed", at(t0, i * 15), anonymous, { ...evil, request_id: randomUUID() }, { type: "account", id: victim.id }, { account_key: victim.accountKey, known_account: true, reason: "invalid_credentials" }),
      );
    }
    case "password_spraying": {
      const s = src(ip(1), ATTACK_AGENT);
      return USERS.map((u, i) => draft("auth.login_failed", at(t0, i * 40), anonymous, { ...s, request_id: randomUUID() }, { type: "account", id: u.id }, { account_key: u.accountKey, known_account: true, reason: "invalid_credentials" }));
    }
    case "success_after_failures": {
      const victim = byName("Ethan");
      const s = src(ip(2), ATTACK_AGENT);
      const fails = Array.from({ length: 6 }, (_, i) => draft("auth.login_failed", at(t0, i * 20), anonymous, { ...s, request_id: randomUUID() }, { type: "account", id: victim.id }, { account_key: victim.accountKey, known_account: true, reason: "invalid_credentials" }));
      return [...fails, draft("auth.login_succeeded", at(t0, 150), anonymous, { ...s, request_id: randomUUID() }, { type: "account", id: victim.id }, { account_key: victim.accountKey, user_id: victim.id })];
    }
    case "idor_probing": {
      const rep = byName("Daniel");
      return Array.from({ length: 18 }, (_, i) =>
        draft("authz.denied", at(t0, i * 12), userActor(rep), src(ip(3)), { type: "order", id: randomUUID() }, { action: "view", resource: "order", target_id: null, reason: "not_visible" }),
      );
    }
    case "privilege_escalation": {
      const insider = byName("Lukas");
      const target = byName("Hannah");
      return [
        draft("authz.denied", at(t0, 0), userActor(insider), src(insider.ip), { type: "team", id: null }, { action: "manage", resource: "team", target_id: null, reason: "not_permitted" }),
        draft("authz.denied", at(t0, 30), userActor(insider), src(insider.ip), { type: "api_key", id: null }, { action: "create", resource: "api_key", target_id: null, reason: "not_permitted" }),
        draft("role.changed", at(t0, 240), userActor(insider), src(insider.ip), { type: "profile", id: target.id }, { from_role: "sales_rep", to_role: "admin" }),
      ];
    }
    case "api_key_abuse": {
      const [make, n8n, form] = API_KEYS;
      const s = src(ip(4), ATTACK_AGENT);
      return [
        ...Array.from({ length: 6 }, (_, i) => draft("api.auth_failed", at(t0, i * 10), anonymous, { ...s, request_id: randomUUID() }, { type: "api_key", id: form!.id }, { reason: "wrong_secret", prefix: form!.prefix, path: "/leads" })),
        draft("api_key.used_after_revoke", at(t0, 90), { type: "api_key", api_key_id: n8n!.id }, { ...s, request_id: randomUUID() }, { type: "api_key", id: n8n!.id }, { prefix: n8n!.prefix, revoked_at: at(t0, -86_400).toISOString(), path: "/companies" }),
        // The Make key probes endpoints outside its scopes from its usual IP (a compromised scenario, not a new host).
        ...Array.from({ length: 6 }, (_, i) =>
          draft("api.scope_denied", at(t0, 120 + i * 15), { type: "api_key", api_key_id: make!.id }, src(make!.ip, "Make/production"), { type: "api_key", id: make!.id }, { required: "security:read", scopes: ["leads:write"], path: "/security-events" }),
        ),
      ];
    }
    case "data_exfiltration": {
      const m = byName("Marcus");
      return [draft("data.bulk_read", t0, userActor(m), src(m.ip), undefined, { resource: "contact", records: 2400 + Math.floor(r() * 400), threshold: 300, window_seconds: 300 })];
    }
    case "automation_tampering": {
      const m = byName("Marcus");
      return [
        draft("workflow.updated", t0, userActor(m), src(m.ip), { type: "workflow", id: WORKFLOW_IDS[1]! }, { version: 9, fields: ["definition"] }),
        draft("integration.webhook_sent", at(t0, 420), service, src(null, null), { type: "integration", id: WORKFLOW_IDS[1]! }, { provider: "generic_webhook", domain: "collector.drop-zone.example", event_type: "lead.created", attempt: 1, status_code: 200, outcome: "success" }),
      ];
    }
    case "ssrf_attempt": {
      const admin = byName("Olivia");
      return [
        draft("security.ssrf_blocked", t0, userActor(admin), src(ip(0)), { type: "integration", id: null }, { provider: "generic_webhook", host: "169.254.169.254", reason: "The address is link-local (includes cloud metadata 169.254.169.254).", stage: "configuration" }),
      ];
    }
    case "forgery": {
      const s = src(ip(2), "curl/8.9.1");
      return [
        draft("cron.unauthorized", t0, anonymous, s, { type: "endpoint", id: "/api/cron/scheduler" }, { method: "POST", ip: ip(2) }),
        draft("webhook.signature_invalid", at(t0, 60), { type: "api_key", api_key_id: API_KEYS[1]!.id }, { ...s, request_id: randomUUID() }, { type: "integration", id: null }, { provider: "n8n", reason: "mismatch", event_type: "n8n.follow_up_requested" }),
      ];
    }
    case "log_tampering": {
      const m = byName("Marcus");
      return [
        // Modified after it was written: the stored hash no longer matches the content.
        draft("data.bulk_read", t0, userActor(m), src(m.ip), undefined, { resource: "company", records: 4100, threshold: 300, window_seconds: 300 }, { tamper: true }),
        // Two events were deleted before this one: the sequence jumps.
        draft("settings.changed", at(t0, 30), userActor(m), src(m.ip), { type: "organization", id: SIM_ORG_ID }, { fields: ["order_conversion_mode"] }, { skipBefore: 3 }),
      ];
    }
  }
}
