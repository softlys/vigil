/**
 * Runs the simulator against the database: a one-time backfill (bootstrap, a few days of baseline,
 * and every attack scenario at fixed points in the past) and then live ticks that add baseline
 * activity up to "now". Scenarios can also be triggered on demand from Settings.
 */
import type { Sql } from "@/lib/db";
import { getConnectorState, ingestEvents, type IngestResult } from "@/lib/ingest";
import { baseline, bootstrap, exportHistory, rng, scenario, SCENARIOS, seal, type Draft, type ScenarioKey } from "./generator";
import { SIM_ORG_ID } from "./world";

const DAY = 86_400_000;

async function append(sql: Sql, drafts: Draft[]): Promise<IngestResult> {
  const state = await getConnectorState(sql, "simulator", SIM_ORG_ID);
  const previous = state.last_sequence > 0 ? { sequence: state.last_sequence, hash: state.last_hash } : null;
  const events = seal(drafts, previous);
  return ingestEvents(sql, "simulator", events);
}

/**
 * Moves a scenario so its last event happens at `end`. Scenarios are written forward from their
 * start time; run as-is from "now" they would contain events from the next few minutes.
 */
export function endingAt(drafts: Draft[], end: Date): Draft[] {
  if (drafts.length === 0) return drafts;
  const last = Math.max(...drafts.map((d) => Date.parse(d.occurred_at)));
  const shift = end.getTime() - last;
  if (shift >= 0) return drafts;
  return drafts.map((d) => ({ ...d, occurred_at: new Date(Date.parse(d.occurred_at) + shift).toISOString() }));
}

/** Most recent time before `now` that is outside working hours (02:30 UTC). */
function lastNight(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 30));
  return d.getTime() < now.getTime() ? d : new Date(d.getTime() - DAY);
}

/**
 * First run only: three days of history ending now, with each scenario placed at a fixed point so
 * the demo opens with alerts and incidents to investigate.
 */
export async function backfill(sql: Sql, now: Date, days = 3): Promise<{ events: number; scenarios: number }> {
  const state = await getConnectorState(sql, "simulator", SIM_ORG_ID);
  if (state.last_sequence > 0) return { events: 0, scenarios: 0 };
  const start = new Date(now.getTime() - days * DAY);
  const r = rng(20261020);
  const exfilAt = new Date(now.getTime() - 0.4 * DAY);
  // Daily exports before the exfiltration scenario give VGL-011 its baseline even across a weekend.
  const drafts: Draft[] = [...bootstrap(start), ...exportHistory(exfilAt, 4)];
  drafts.push(...baseline(new Date(start.getTime() + 60_000), now, r, null));
  // Scenarios at fixed offsets; privilege escalation at night so VGL-005 applies too.
  const plan: Array<[ScenarioKey, Date]> = [
    ["brute_force", new Date(now.getTime() - 2.6 * DAY)],
    ["idor_probing", new Date(now.getTime() - 2.2 * DAY)],
    ["password_spraying", new Date(now.getTime() - 1.8 * DAY)],
    ["privilege_escalation", lastNight(new Date(now.getTime() - DAY))],
    ["success_after_failures", new Date(now.getTime() - 0.9 * DAY)],
    ["api_key_abuse", new Date(now.getTime() - 0.6 * DAY)],
    ["data_exfiltration", exfilAt],
    ["automation_tampering", new Date(now.getTime() - 0.25 * DAY)],
    ["ssrf_attempt", new Date(now.getTime() - 0.15 * DAY)],
    ["forgery", new Date(now.getTime() - 0.08 * DAY)],
    ["log_tampering", new Date(now.getTime() - 0.03 * DAY)],
  ];
  for (const [key, t] of plan) drafts.push(...scenario(key, t, r).filter((d) => Date.parse(d.occurred_at) <= now.getTime()));
  drafts.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  // Keep chain-tampering drafts adjacent so the gap and break land where planned.
  const result = await append(sql, drafts);
  return { events: result.stored, scenarios: plan.length };
}

const MAX_CATCH_UP = 7 * DAY;

/**
 * Adds baseline activity from the last simulated event up to `now`. After downtime it catches up
 * (at most 7 days), so stopping the demo does not look like a heartbeat gap.
 */
export async function tick(sql: Sql, now: Date): Promise<number> {
  const state = await getConnectorState(sql, "simulator", SIM_ORG_ID);
  if (!state.last_event_at) return 0;
  const from = new Date(Math.max(Date.parse(state.last_event_at), now.getTime() - MAX_CATCH_UP));
  if (now.getTime() - from.getTime() < 30_000) return 0;
  const r = rng(Math.floor(now.getTime() / 1000));
  const lastHb = state.last_heartbeat_at ? new Date(state.last_heartbeat_at) : null;
  const drafts = baseline(from, now, r, lastHb && lastHb.getTime() > now.getTime() - MAX_CATCH_UP ? lastHb : null);
  if (drafts.length === 0) return 0;
  return (await append(sql, drafts)).stored;
}

/** Runs one attack scenario now (Settings → Simulator). */
export async function runScenario(sql: Sql, key: ScenarioKey, now: Date): Promise<IngestResult> {
  const r = rng(Math.floor(now.getTime() / 1000));
  const attack = endingAt(scenario(key, now, r), now);
  const drafts = key === "data_exfiltration" ? [...exportHistory(now, 4), ...attack] : attack;
  return append(sql, drafts.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)));
}

export { SCENARIOS };
