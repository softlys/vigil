import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashEvent, type SecurityEvent } from "@/domain/event-schema";
import type { Sql } from "@/lib/db";
import { checkHeartbeats, ingestEvents, parseEvents, SchemaMismatchError } from "@/lib/ingest";
import { archiveOldEvents } from "@/lib/retention";
import { baseline, bootstrap, rng, seal } from "@/simulator/generator";
import { SIM_ORG_ID } from "@/simulator/world";
import { freshDb, sorted } from "./helpers";

let sql: Sql;
beforeEach(async () => {
  sql = await freshDb();
});
afterEach(async () => {
  await sql.close();
});

const START = new Date("2026-10-14T08:00:00Z");
function chain(minutes = 60): SecurityEvent[] {
  return seal(sorted([...bootstrap(START), ...baseline(new Date(START.getTime() + 60_000), new Date(START.getTime() + minutes * 60_000), rng(1), null)]), null);
}

describe("schema validation", () => {
  it("accepts NEXORA events and fails loudly on a mismatch", () => {
    const events = chain(20);
    expect(parseEvents(JSON.parse(JSON.stringify(events)))).toHaveLength(events.length);
    const broken = { ...events[0]!, action: "auth.password_changed" };
    expect(() => parseEvents([broken])).toThrow(SchemaMismatchError);
    const missing: Record<string, unknown> = { ...events[0]! };
    delete missing.hash;
    expect(() => parseEvents([missing])).toThrow(/sequence 1/);
  });
});

describe("hash chain verification on ingest", () => {
  it("stores a valid chain with every event verified", async () => {
    const events = chain();
    const r = await ingestEvents(sql, "simulator", events);
    expect(r.stored).toBe(events.length);
    expect(r.findings).toEqual([]);
    const bad = await sql.query("select 1 from events where not chain_ok");
    expect(bad).toHaveLength(0);
  });

  it("ignores re-delivered events (idempotent polling and push)", async () => {
    const events = chain(30);
    await ingestEvents(sql, "simulator", events);
    const again = await ingestEvents(sql, "simulator", events);
    expect(again).toMatchObject({ stored: 0, duplicates: events.length });
  });

  it("detects history rewritten after VIGIL read it (a different event at a stored sequence)", async () => {
    const events = chain(30);
    await ingestEvents(sql, "simulator", events);
    // NEXORA later serves the same first 6 events, but event 6 was edited and re-hashed in place.
    const edited = { ...events[5]!, metadata: { ...events[5]!.metadata, rewritten: true } };
    const { hash: _h, prev_hash: _p, ...body } = edited;
    void _h;
    const rewritten = [...events.slice(0, 5), { ...edited, hash: hashEvent(_p, body) }];
    const r = await ingestEvents(sql, "simulator", rewritten);
    expect(r.stored).toBe(0);
    expect(r.findings.map((f) => f.detail)).toEqual([expect.stringContaining("Conflicting event at sequence 6")]);
    expect((await ingestEvents(sql, "simulator", rewritten)).findings).toEqual([]); // recorded once
  });

  it("detects a modified event (hash mismatch)", async () => {
    const events = chain(30);
    const i = 5;
    events[i] = { ...events[i]!, metadata: { ...events[i]!.metadata, records: 1 } };
    const r = await ingestEvents(sql, "simulator", events);
    expect(r.findings.map((f) => f.kind)).toEqual(["chain_break"]);
    expect(r.findings[0]!.detail).toContain(`sequence ${events[i]!.sequence}`);
  });

  it("detects deleted events (sequence gap) and a re-linked chain (prev_hash mismatch)", async () => {
    const events = chain(40);
    const gapped = [...events.slice(0, 4), ...events.slice(7)];
    expect((await ingestEvents(sql, "simulator", gapped)).findings.map((f) => f.kind)).toEqual(["sequence_gap"]);

    const other = await freshDb();
    // Attacker deletes event 4 and renumbers: sequence continues but prev_hash no longer links.
    const forged = [...events.slice(0, 3), { ...events[4]!, sequence: 4 }];
    const { hash: _h, prev_hash: _p, ...body } = forged[3]!;
    void _h;
    void _p;
    forged[3] = { ...forged[3]!, hash: hashEvent(forged[3]!.prev_hash, body) };
    expect((await ingestEvents(other, "simulator", forged)).findings.map((f) => f.kind)).toEqual(["chain_break"]);
    await other.close();
  });

  it("records a past heartbeat gap and a live one, once each", async () => {
    const events = chain(30);
    // Drop the heartbeats between minute 5 and 25: a 20-minute silence in history.
    const quiet = events.filter((e) => !(e.action === "system.heartbeat" && e.occurred_at > "2026-10-14T08:05:00Z" && e.occurred_at < "2026-10-14T08:25:00Z"));
    // Re-seal the remaining events as a consistent chain (NEXORA never wrote those heartbeats).
    const resealed = seal(
      quiet.map((e) => ({ action: e.action, occurred_at: e.occurred_at, actor: e.actor, source: e.source, target: e.target, metadata: e.metadata })),
      null,
    );
    const r = await ingestEvents(sql, "simulator", resealed);
    expect(r.findings.map((f) => f.kind)).toEqual(["heartbeat_gap"]);
    expect(await checkHeartbeats(sql, new Date("2026-10-14T08:40:00Z"))).toBe(0);
    expect(await checkHeartbeats(sql, new Date("2026-10-14T09:00:00Z"))).toBe(1);
    expect(await checkHeartbeats(sql, new Date("2026-10-14T09:10:00Z"))).toBe(0); // same silent period
  });
});

describe("append-only events and retention", () => {
  it("rejects updates and deletes outside the archive job", async () => {
    await ingestEvents(sql, "simulator", chain(10));
    await expect(sql.query("update events set action = 'x'")).rejects.toThrow(/append-only/);
    await expect(sql.query("delete from events")).rejects.toThrow(/append-only/);
  });

  it("moves events older than the retention period to the archive", async () => {
    await ingestEvents(sql, "simulator", chain(30));
    const total = (await sql.query<{ n: number }>("select count(*)::int as n from events"))[0]!.n;
    await sql.query("insert into settings (key, value) values ('retention_days', '7') on conflict (key) do update set value = excluded.value");
    const r = await archiveOldEvents(sql, new Date("2026-10-21T08:15:00Z"));
    expect(r.ran).toBe(true);
    const left = (await sql.query<{ n: number }>("select count(*)::int as n from events"))[0]!.n;
    const archived = (await sql.query<{ n: number }>("select count(*)::int as n from events_archive"))[0]!.n;
    expect(archived).toBe(r.archived);
    expect(left + archived).toBe(total);
    expect(archived).toBeGreaterThan(0);
    expect((await archiveOldEvents(sql, new Date("2026-10-21T09:00:00Z"))).ran).toBe(false); // once a day
  });
});

export { SIM_ORG_ID };
