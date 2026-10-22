import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetection, runIntegrityAlerts, toNorm, type EventRow } from "@/detection/live";
import { backtest } from "@/detection/memory";
import { durationMs } from "@/detection/schema";
import type { SecurityEvent } from "@/domain/event-schema";
import { raiseAlert } from "@/lib/alerts";
import type { Sql } from "@/lib/db";
import { backoffMs, connectorHealth, pollNexora } from "@/lib/connector";
import { getConfig } from "@/lib/config";
import { ingestEvents } from "@/lib/ingest";
import { notifyNewAlerts } from "@/lib/notify";
import { approveResponse, proposeResponse, rejectResponse, responseCandidates, ResponseError } from "@/lib/response";
import { backfill } from "@/simulator/run";
import { bootstrap, exportHistory, rng, scenario, SCENARIOS, seal } from "@/simulator/generator";
import { freshDb, RULES, sorted } from "./helpers";

let sql: Sql;
beforeEach(async () => {
  sql = await freshDb();
});
afterEach(async () => {
  await sql.close();
});

const T0 = new Date("2026-10-14T02:30:00Z");

describe("alert dedup and incident grouping", () => {
  const base = { rule: RULES["VGL-001"]!, ruleVersion: 1, key: "acct", entity: { field: "metadata.account_key", value: "acct" }, summary: "s", simulated: true, scope: "simulator:org" };

  it("updates one alert for repeated hits inside the dedup window, opens a new one after it", async () => {
    const a = await raiseAlert(sql, { ...base, eventIds: [1], at: "2026-10-14T02:30:00.000Z" });
    const b = await raiseAlert(sql, { ...base, eventIds: [2], at: "2026-10-14T02:50:00.000Z" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.alert).toMatchObject({ id: a.alert.id, count: 2, event_ids: [1, 2] });
    const c = await raiseAlert(sql, { ...base, eventIds: [3], at: "2026-10-14T05:00:00.000Z" }); // 1h window passed
    expect(c.created).toBe(true);
    // Same entity within 24 h: same incident.
    expect(c.alert.incident_id).toBe(a.alert.incident_id);
  });

  it("puts alerts about different entities into different incidents, and simulated apart from real", async () => {
    const a = await raiseAlert(sql, { ...base, eventIds: [1], at: "2026-10-14T02:30:00.000Z" });
    const b = await raiseAlert(sql, { ...base, key: "other", entity: { field: "metadata.account_key", value: "other" }, eventIds: [2], at: "2026-10-14T02:31:00.000Z" });
    const c = await raiseAlert(sql, { ...base, simulated: false, scope: "nexora:org", eventIds: [3], at: "2026-10-14T02:32:00.000Z" });
    expect(new Set([a.alert.incident_id, b.alert.incident_id, c.alert.incident_id]).size).toBe(3);
  });
});

describe("simulator scenarios end to end (ingest → detection)", () => {
  for (const s of SCENARIOS) {
    it(`${s.key}: each expected alert fires exactly once`, async () => {
      const r = rng(11);
      const pre = [...bootstrap(new Date(T0.getTime() - 3 * 86_400_000)), ...(s.key === "data_exfiltration" ? exportHistory(T0, 4) : [])];
      await ingestEvents(sql, "simulator", seal(sorted(pre), null));
      // The scenario arrives later, like live traffic, continuing the same chain.
      const tail = (await sql.query<{ last_sequence: number; last_hash: string }>("select last_sequence, last_hash from connector_state"))[0]!;
      await ingestEvents(sql, "simulator", seal(scenario(s.key, T0, r), { sequence: tail.last_sequence, hash: tail.last_hash }));
      await runDetection(sql);
      await runIntegrityAlerts(sql);
      const alerts = await sql.query<{ rule_id: string }>("select rule_id from alerts order by rule_id");
      expect(alerts.map((a) => a.rule_id)).toEqual([...s.rules].sort());
      // Running detection again changes nothing (cursor), and every alert is in an incident.
      await runDetection(sql);
      expect((await sql.query("select 1 from alerts")).length).toBe(s.rules.length);
      expect((await sql.query("select 1 from alerts where incident_id is null")).length).toBe(0);
    });
  }

  it("the demo backfill raises every built-in rule at least once", async () => {
    await backfill(sql, new Date("2026-10-20T15:00:00Z"));
    await runDetection(sql);
    await runIntegrityAlerts(sql);
    const fired = new Set((await sql.query<{ rule_id: string }>("select distinct rule_id from alerts")).map((a) => a.rule_id));
    expect([...fired].sort()).toEqual(Object.keys(RULES).sort());
  });
});

describe("NEXORA connector", () => {
  const config = { ...getConfig({ NEXORA_URL: "https://nexora.example", NEXORA_SECURITY_API_KEY: "nxk_siem_test_key" } as unknown as NodeJS.ProcessEnv) };

  function fakeNexora(events: SecurityEvent[], calls: string[]) {
    return (async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer nxk_siem_test_key");
      const u = new URL(url);
      const after = Number(u.searchParams.get("after"));
      const limit = Number(u.searchParams.get("limit"));
      const rest = events.filter((e) => e.sequence > after);
      const page = rest.slice(0, limit);
      return new Response(JSON.stringify({ data: page, meta: { next_after_sequence: page.at(-1)?.sequence ?? after, has_more: rest.length > page.length, last_sequence: events.at(-1)?.sequence ?? 0 } }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("pages through events and resumes from the stored cursor after a restart", async () => {
    const nexoraEvents = seal(sorted(bootstrap(T0)), null);
    const calls: string[] = [];
    const first = await pollNexora(sql, T0, { config: { ...config, nexora: { ...config.nexora, pageSize: 2 } }, fetchImpl: fakeNexora(nexoraEvents.slice(0, 4), calls), maxPages: 10 });
    expect(first).toMatchObject({ ran: true, stored: 4, error: null });
    expect(calls.map((c) => new URL(c).searchParams.get("after"))).toEqual(["0", "2"]);

    // "Restart": a new poll reads the cursor from the database, not from memory.
    calls.length = 0;
    const later = new Date(T0.getTime() + 60_000);
    const second = await pollNexora(sql, later, { config, fetchImpl: fakeNexora(nexoraEvents, calls) });
    expect(new URL(calls[0]!).searchParams.get("after")).toBe("4");
    expect(second.stored).toBe(nexoraEvents.length - 4);
    expect((await sql.query("select 1 from events where source = 'nexora'")).length).toBe(nexoraEvents.length);
  });

  it("backs off on errors and stops on a schema mismatch", async () => {
    const failing = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    const r = await pollNexora(sql, T0, { config, fetchImpl: failing });
    expect(r.error).toContain("HTTP 503");
    const h = await connectorHealth(sql);
    expect(h.consecutive_failures).toBe(1);
    expect(Date.parse(h.next_attempt_at!) - T0.getTime()).toBe(backoffMs(1));
    expect((await pollNexora(sql, new Date(T0.getTime() + 1000), { config, fetchImpl: failing })).ran).toBe(false); // waiting

    const bad = (async () => new Response(JSON.stringify({ data: [{ sequence: 1, action: "nope" }], meta: { next_after_sequence: 0, has_more: false, last_sequence: 1 } }), { status: 200 })) as unknown as typeof fetch;
    const m = await pollNexora(sql, new Date(T0.getTime() + 600_000), { config, fetchImpl: bad, force: true });
    expect(m.error).toMatch(/does not match the NEXORA security event schema/);
    expect((await connectorHealth(sql)).stopped_reason).toMatch(/Schema mismatch/);
  });
});

/**
 * An incident whose evidence contains real events: API key abuse and a privilege escalation, so
 * it has both an API key and users that a response may target.
 */
async function responseIncident(simulated: boolean): Promise<{ id: string; key: string; user: string }> {
  await ingestEvents(sql, "simulator", seal(sorted([...scenario("api_key_abuse", T0, rng(3)), ...scenario("privilege_escalation", T0, rng(4))]), null));
  const events = await sql.query<{ id: number; actor_type: string; actor_id: string | null; target_type: string | null; target_id: string | null; action: string }>("select * from events order by id");
  const a = await raiseAlert(sql, { rule: RULES["VGL-008"]!, ruleVersion: 1, key: "k", entity: { field: "target.id", value: "k" }, eventIds: events.map((e) => e.id), at: T0.toISOString(), summary: "s", simulated, scope: simulated ? "simulator:o" : "nexora:o" });
  const c = responseCandidates(events);
  return { id: a.alert.incident_id!, key: c.keys[0]!.id, user: c.users[0]!.id };
}

describe("response actions", () => {
  const incident = async (simulated: boolean) => {
    const r = await responseIncident(simulated);
    KEY = r.key;
    USER = r.user;
    return r.id;
  };
  const admin = { id: "00000000-0000-4000-8000-000000000001", email: "admin@vigil.example" };
  const analyst = { id: "00000000-0000-4000-8000-000000000002", email: "analyst@vigil.example" };
  let KEY = "";
  let USER = "";

  it("simulated incidents record the action without calling NEXORA", async () => {
    const id = await incident(true);
    const actionId = await proposeResponse(sql, { incidentId: id, kind: "revoke_api_key", targetId: KEY, targetLabel: null, actor: analyst });
    let called = false;
    const r = await approveResponse(sql, { actionId, reason: "Key abused from 203.0.113.45", admin, executor: async () => ((called = true), { status: 200, body: "" }) });
    expect(r).toEqual({ status: "executed", simulated: true });
    expect(called).toBe(false);
    const timeline = await sql.query<{ body: string }>("select body from incident_timeline where incident_id = $1 and kind = 'response' order by id", [id]);
    expect(timeline.at(-1)!.body).toContain("Executed (simulated)");
    expect((await sql.query<{ action: string }>("select action from audit_log")).map((a) => a.action)).toEqual(["response.proposed", "response.executed"]);
  });

  it("real incidents call the security-actions API with the respond key and log the result", async () => {
    const id = await incident(false);
    const actionId = await proposeResponse(sql, { incidentId: id, kind: "disable_user", targetId: USER, targetLabel: "Daniel", actor: analyst });
    const seen: Array<{ url: string; key: string; body: Record<string, unknown> }> = [];
    const cfg = getConfig({ NEXORA_URL: "https://nexora.example", NEXORA_SECURITY_API_KEY: "read", NEXORA_RESPONSE_API_KEY: "respond" } as unknown as NodeJS.ProcessEnv);
    const r = await approveResponse(sql, { actionId, reason: "Confirmed account takeover", admin, config: cfg, executor: async (x) => (seen.push(x), { status: 200, body: '{"data":{"changed":true}}' }) });
    expect(r.status).toBe("executed");
    expect(seen[0]).toMatchObject({ url: "https://nexora.example/api/v1/security-actions/disable-user", key: "respond", body: { user_id: USER } });
    const stored = (await sql.query<{ request_summary: Record<string, unknown> }>("select request_summary from response_actions where id = $1", [actionId]))[0]!;
    expect(JSON.stringify(stored.request_summary)).not.toContain("respond\"");
  });

  it("requires a reason, refuses double decisions and records failures", async () => {
    const id = await incident(false);
    const actionId = await proposeResponse(sql, { incidentId: id, kind: "revoke_api_key", targetId: KEY, targetLabel: null, actor: analyst });
    await expect(approveResponse(sql, { actionId, reason: "ok", admin })).rejects.toThrow(ResponseError);
    await expect(proposeResponse(sql, { incidentId: id, kind: "revoke_api_key", targetId: KEY, targetLabel: null, actor: admin })).rejects.toThrow(/already waiting/);
    await expect(proposeResponse(sql, { incidentId: id, kind: "revoke_api_key", targetId: "not-a-uuid", targetLabel: null, actor: admin })).rejects.toThrow(/UUID/);
    // A valid id that is not part of this incident's events.
    await expect(proposeResponse(sql, { incidentId: id, kind: "disable_user", targetId: "0000a000-0000-4000-8000-00000000ffff", targetLabel: null, actor: admin })).rejects.toThrow(/does not appear/);
    const noKey = getConfig({} as NodeJS.ProcessEnv);
    const r = await approveResponse(sql, { actionId, reason: "Rotate after leak", admin, config: noKey });
    expect(r.status).toBe("failed");
    await expect(rejectResponse(sql, { actionId, reason: "too late now", admin })).rejects.toThrow(/already failed/);
  });
});

describe("backtest matches live detection", () => {
  it("raises the same alerts, at the same times, with the same hit counts", async () => {
    // Several scenarios on top of the baseline, so rules see both noise and attacks.
    const r = rng(5);
    await ingestEvents(sql, "simulator", seal(sorted([...bootstrap(new Date(T0.getTime() - 3 * 86_400_000)), ...exportHistory(T0, 4)]), null));
    for (const [n, key] of (["brute_force", "password_spraying", "success_after_failures", "data_exfiltration", "api_key_abuse", "privilege_escalation"] as const).entries()) {
      const tail = (await sql.query<{ last_sequence: number; last_hash: string }>("select last_sequence, last_hash from connector_state"))[0]!;
      await ingestEvents(sql, "simulator", seal(scenario(key, new Date(T0.getTime() + n * 3_600_000), r), { sequence: tail.last_sequence, hash: tail.last_hash }));
      await runDetection(sql);
    }
    const live = await sql.query<{ rule_id: string; first_seen_at: string; count: number }>("select rule_id, first_seen_at, count from alerts order by rule_id, first_seen_at");
    expect(live.length).toBeGreaterThan(0);
    const events = (await sql.query<EventRow>("select * from events order by id")).map(toNorm);
    const replayed: Array<{ rule_id: string; first_seen_at: string; count: number }> = [];
    for (const rule of Object.values(RULES)) {
      if (rule.type === "integrity") continue;
      for (const h of await backtest(rule, events, durationMs(rule.dedup_window))) replayed.push({ rule_id: rule.id, first_seen_at: new Date(h.at).toISOString(), count: h.count });
    }
    const norm = (rows: typeof live) => rows.map((a) => `${a.rule_id} ${new Date(a.first_seen_at).toISOString()} ×${a.count}`).sort();
    expect(norm(replayed)).toEqual(norm(live));
  });
});

describe("four eyes", () => {
  it("the admin who proposed an action cannot approve it", async () => {
    const inc = await responseIncident(true);
    const admin = { id: "00000000-0000-4000-8000-000000000001", email: "admin@vigil.example" };
    const actionId = await proposeResponse(sql, { incidentId: inc.id, kind: "revoke_api_key", targetId: inc.key, targetLabel: null, actor: admin });
    await expect(approveResponse(sql, { actionId, reason: "Approving my own idea", admin })).rejects.toThrow(/another admin/);
    const other = { id: "00000000-0000-4000-8000-000000000003", email: "second@vigil.example" };
    expect((await approveResponse(sql, { actionId, reason: "Reviewed and confirmed", admin: other })).status).toBe("executed");
  });

  it("two admins deciding at once: exactly one decision wins", async () => {
    const inc = await responseIncident(true);
    const analyst = { id: "00000000-0000-4000-8000-000000000002", email: "analyst@vigil.example" };
    const actionId = await proposeResponse(sql, { incidentId: inc.id, kind: "revoke_api_key", targetId: inc.key, targetLabel: null, actor: analyst });
    const a = { id: "00000000-0000-4000-8000-000000000001", email: "a@vigil.example" };
    const b = { id: "00000000-0000-4000-8000-000000000003", email: "b@vigil.example" };
    const results = await Promise.allSettled([
      approveResponse(sql, { actionId, reason: "Approve from admin A", admin: a }),
      rejectResponse(sql, { actionId, reason: "Reject from admin B", admin: b }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const decisions = await sql.query("select 1 from incident_timeline where incident_id = $1 and kind = 'response' and (data->>'status') <> 'proposed'", [inc.id]);
    expect(decisions).toHaveLength(1);
  });
});

describe("notifications", () => {
  it("skips without channels, sends to configured ones, and never twice", async () => {
    await raiseAlert(sql, { rule: RULES["VGL-003"]!, ruleVersion: 1, key: "k", entity: { field: "metadata.account_key", value: "k" }, eventIds: [], at: T0.toISOString(), summary: "s", simulated: false, scope: "nexora:o" });
    expect(await notifyNewAlerts(sql, { env: {} as NodeJS.ProcessEnv })).toBe(0);
    expect((await sql.query<{ status: string }>("select status from notifications"))[0]!.status).toBe("skipped");

    await raiseAlert(sql, { rule: RULES["VGL-006"]!, ruleVersion: 1, key: "a", entity: { field: "actor.id", value: "a" }, eventIds: [], at: T0.toISOString(), summary: "s", simulated: false, scope: "nexora:o" });
    const posts: string[] = [];
    const fetchImpl = (async (url: string) => (posts.push(url), new Response("ok"))) as unknown as typeof fetch;
    const env = { VIGIL_SLACK_WEBHOOK_URL: "https://hooks.slack.example/T/B/X" } as unknown as NodeJS.ProcessEnv;
    expect(await notifyNewAlerts(sql, { env, fetchImpl })).toBe(1);
    expect(posts).toEqual(["https://hooks.slack.example/T/B/X"]);
    expect(await notifyNewAlerts(sql, { env, fetchImpl })).toBe(0);
  });
});
