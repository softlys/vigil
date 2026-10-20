import { describe, expect, it } from "vitest";
import { evaluate, outsideHours, type NormEvent } from "@/detection/engine";
import { backtest, MemoryHistory } from "@/detection/memory";
import { durationMs, validateRule, type Rule } from "@/detection/schema";
import { SECURITY_ACTION_NAMES } from "@/domain/event-schema";
import { bootstrap, exportHistory, rng, scenario, SCENARIOS, type ScenarioKey } from "@/simulator/generator";
import { normalize, RULES, sealDrafts, sorted } from "./helpers";

const T0 = new Date("2026-10-14T02:30:00Z"); // a Wednesday night: outside working hours
const DAY_T = new Date("2026-10-14T11:00:00Z"); // Wednesday mid-day: inside working hours

let nextId = 1;
function ev(partial: Partial<NormEvent> & { action: string; occurred_at: string }): NormEvent {
  return {
    id: nextId++,
    source: "simulator",
    simulated: true,
    organization_id: "7f3c2a10-5b6d-4e8f-9a01-2c3d4e5f6a70",
    sequence: nextId,
    category: "authentication",
    outcome: "failure",
    severity: "low",
    actor: { type: "anonymous", id: null, role: null },
    source_info: { ip: "203.0.113.5", user_agent: null },
    target: { type: null, id: null },
    metadata: {},
    ...partial,
  };
}
const at = (s: number) => new Date(T0.getTime() + s * 1000).toISOString();

/** Feeds events in order and returns the hits (no dedup). */
async function run(rule: Rule, events: NormEvent[]) {
  const h = new MemoryHistory();
  const hits = [];
  for (const e of events) {
    h.add(e);
    const hit = await evaluate(rule, e, h);
    if (hit) hits.push(hit);
  }
  return hits;
}

/** Same as live detection: one alert per key while the dedup window is open. */
async function alerts(rule: Rule, events: NormEvent[]) {
  return backtest(rule, events, durationMs(rule.dedup_window));
}

describe("rule schema", () => {
  it("loads and validates all 15 built-in rules, each with ATT&CK techniques", () => {
    expect(Object.keys(RULES)).toHaveLength(15);
    for (const r of Object.values(RULES)) {
      expect(r.mitre.length).toBeGreaterThan(0);
      expect(r.false_positives.length).toBeGreaterThan(0);
    }
  });

  it("only references actions NEXORA actually emits", () => {
    const actions = new Set<string>(SECURITY_ACTION_NAMES);
    const refs = JSON.stringify(Object.values(RULES)).match(/"action":(\{"in":\[[^\]]*\]\}|"[^"]+")/g) ?? [];
    for (const ref of refs) for (const a of ref.match(/"([a-z_]+\.[a-z_]+)"/g) ?? []) expect(actions.has(a.replace(/"/g, ""))).toBe(true);
  });

  it("rejects unknown fields, bad durations, bad ATT&CK ids and windows over 7 days", () => {
    const base = { ...RULES["VGL-001"] };
    expect(validateRule({ ...base, query: { "actor.password": "x" } }).ok).toBe(false);
    expect(validateRule({ ...base, window: "10 minutes" }).ok).toBe(false);
    expect(validateRule({ ...base, mitre: [{ id: "TA0006", name: "x", tactic: "y" }] }).ok).toBe(false);
    expect(validateRule({ ...base, window: "8d" }).ok).toBe(false);
    expect(validateRule({ ...base, extra: true }).ok).toBe(false);
    expect(validateRule(base).ok).toBe(true);
  });
});

describe("rule types", () => {
  it("single: fires on every matching event, not on others", async () => {
    const rule = RULES["VGL-013"]!;
    const hits = await run(rule, [ev({ action: "security.ssrf_blocked", occurred_at: at(0), metadata: { host: "169.254.169.254" } }), ev({ action: "auth.login_failed", occurred_at: at(1) })]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.key).toBe("169.254.169.254");
  });

  it("single + outside_hours: only at night or on weekends", async () => {
    const rule = RULES["VGL-005"]!;
    const role = (t: string) => ev({ action: "role.changed", occurred_at: t, metadata: { to_role: "admin" }, target: { type: "profile", id: "u1" } });
    expect(await run(rule, [role(T0.toISOString())])).toHaveLength(1);
    expect(await run(rule, [role(DAY_T.toISOString())])).toHaveLength(0);
    expect(outsideHours("2026-10-17T11:00:00Z", { start_hour: 7, end_hour: 20, weekdays_only: true, utc_offset_minutes: 0 })).toBe(true); // Saturday
  });

  it("single + baseline: fires above factor × the actor's median, learns new actors silently", async () => {
    const rule = RULES["VGL-011"]!;
    const read = (s: number, records: number, actor = "m1") => ev({ action: "data.bulk_read", occurred_at: at(s), actor: { type: "user", id: actor, role: "manager" }, metadata: { records } });
    const history = [read(-4 * 86400, 350), read(-3 * 86400, 400), read(-2 * 86400, 380)];
    expect(await run(rule, [...history, read(0, 2400)])).toHaveLength(1);
    expect(await run(rule, [...history, read(0, 900)])).toHaveLength(0); // 2.4× median
    expect(await run(rule, [read(0, 5000, "new-user")])).toHaveLength(0); // no baseline yet
  });

  it("threshold: counts per group within the window", async () => {
    const rule = RULES["VGL-001"]!;
    const fail = (s: number, key = "acct1") => ev({ action: "auth.login_failed", occurred_at: at(s), metadata: { account_key: key } });
    expect(await alerts(rule, Array.from({ length: 8 }, (_, i) => fail(i * 30)))).toHaveLength(1);
    expect(await alerts(rule, Array.from({ length: 7 }, (_, i) => fail(i * 30)))).toHaveLength(0);
    // 8 failures spread over 40 minutes never reach 8 within 10 minutes
    expect(await alerts(rule, Array.from({ length: 8 }, (_, i) => fail(i * 300)))).toHaveLength(0);
    // split across accounts
    expect(await alerts(rule, Array.from({ length: 8 }, (_, i) => fail(i * 30, `acct${i % 2}`)))).toHaveLength(0);
  });

  it("threshold with distinct: counts different values, not events", async () => {
    const rule = RULES["VGL-002"]!;
    const fail = (s: number, key: string) => ev({ action: "auth.login_failed", occurred_at: at(s), metadata: { account_key: key } });
    expect(await alerts(rule, Array.from({ length: 6 }, (_, i) => fail(i * 60, `a${i}`)))).toHaveLength(1);
    expect(await alerts(rule, Array.from({ length: 12 }, (_, i) => fail(i * 60, `a${i % 3}`)))).toHaveLength(0);
  });

  it("sequence: A (min count) then B by the same key within the window, in order", async () => {
    const rule = RULES["VGL-003"]!;
    const fail = (s: number) => ev({ action: "auth.login_failed", occurred_at: at(s), metadata: { account_key: "k" } });
    const ok = (s: number, key = "k") => ev({ action: "auth.login_succeeded", occurred_at: at(s), metadata: { account_key: key } });
    expect(await run(rule, [fail(0), fail(10), fail(20), fail(30), fail(40), ok(60)])).toHaveLength(1);
    expect(await run(rule, [fail(0), fail(10), fail(20), fail(30), ok(60)])).toHaveLength(0); // only 4 failures
    expect(await run(rule, [ok(-10), fail(0), fail(10), fail(20), fail(30), fail(40)])).toHaveLength(0); // success came first
    expect(await run(rule, [fail(0), fail(10), fail(20), fail(30), fail(40), ok(60, "other")])).toHaveLength(0);
    expect(await run(rule, [fail(0), fail(10), fail(20), fail(30), fail(40), ok(3600)])).toHaveLength(0); // outside 30m
  });

  it("sequence with first_seen: the final step must be a never-seen value", async () => {
    const rule = RULES["VGL-012"]!;
    const org = { organization_id: "7f3c2a10-5b6d-4e8f-9a01-2c3d4e5f6a70" };
    const upd = (s: number) => ev({ ...org, action: "workflow.updated", occurred_at: at(s), actor: { type: "user", id: "m", role: "manager" } });
    const hook = (s: number, domain: string) => ev({ ...org, action: "integration.webhook_sent", occurred_at: at(s), metadata: { domain } });
    expect(await run(rule, [hook(-86400, "hook.make.example"), upd(0), hook(300, "drop.example")])).toHaveLength(1);
    expect(await run(rule, [hook(-86400, "hook.make.example"), upd(0), hook(300, "hook.make.example")])).toHaveLength(0);
    expect(await run(rule, [hook(300, "drop.example")])).toHaveLength(0); // no workflow change before
  });

  it("new_value: the first value per key is learned, later new values fire", async () => {
    const rule = RULES["VGL-010"]!;
    const use = (s: number, ip: string, key = "key1") => ev({ action: "api.scope_denied", occurred_at: at(s), actor: { type: "api_key", id: key, role: null }, source_info: { ip, user_agent: null } });
    const hits = await run(rule, [use(0, "198.51.100.20"), use(10, "198.51.100.20"), use(20, "203.0.113.9"), use(30, "203.0.113.9"), use(40, "198.51.100.30", "key2")]);
    expect(hits.map((h) => h.key)).toEqual(["key1|203.0.113.9"]);
  });

  it("integrity rules are not evaluated against events (they come from ingestion findings)", async () => {
    expect(await run(RULES["VGL-015"]!, [ev({ action: "system.heartbeat", occurred_at: at(0) })])).toHaveLength(0);
  });
});

describe("built-in rules against simulator scenarios", () => {
  const ORDER: ScenarioKey[] = SCENARIOS.map((s) => s.key);
  const EXPECTED: Record<string, string[]> = Object.fromEntries(SCENARIOS.map((s) => [s.key, [...s.rules]]));
  // Integrity (VGL-015) fires from ingestion; covered in ingest.test.ts and scenarios.test.ts.
  const eventRules = Object.values(RULES).filter((r) => r.type !== "integrity");

  for (const key of ORDER) {
    it(`${key}: fires ${EXPECTED[key]!.join(", ")} and no other rule`, async () => {
      const r = rng(7);
      const pre = [...bootstrap(new Date(T0.getTime() - 3 * 86_400_000)), ...(key === "data_exfiltration" ? exportHistory(T0, 4) : [])];
      const events = normalize(sealDrafts(sorted([...pre, ...scenario(key, T0, r)])));
      const fired: string[] = [];
      for (const rule of eventRules) {
        const a = await alerts(rule, events);
        if (a.length) fired.push(...a.map(() => rule.id));
      }
      const expected = EXPECTED[key]!.filter((id) => id !== "VGL-015");
      expect(fired.sort()).toEqual(expected.sort());
    });
  }

  it("normal baseline activity alone fires nothing", async () => {
    const { baseline } = await import("@/simulator/generator");
    const start = new Date("2026-10-12T00:00:00Z");
    const drafts = [...bootstrap(start), ...baseline(new Date(start.getTime() + 60_000), new Date("2026-10-15T00:00:00Z"), rng(99), null)];
    const events = normalize(sealDrafts(drafts));
    expect(events.length).toBeGreaterThan(800);
    for (const rule of eventRules) expect(await alerts(rule, events), rule.id).toHaveLength(0);
  });
});
