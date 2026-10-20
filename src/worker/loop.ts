/**
 * The worker: one tick does, in order,
 *   1. simulator (demo mode): first-run backfill, then baseline up to now
 *   2. NEXORA connector poll (when configured and due)
 *   3. heartbeat-gap check
 *   4. detection on new events, then integrity findings → alerts
 *   5. notifications for new high-severity alerts
 *   6. retention archive (once a day)
 * It runs as `npm run worker` (separate process, for PostgreSQL deployments) or inside the web
 * server (default with the embedded demo database, which only one process can open).
 */
import { runDetection, runIntegrityAlerts } from "@/detection/live";
import { bootstrap } from "@/lib/bootstrap";
import { getConfig } from "@/lib/config";
import { pollNexora } from "@/lib/connector";
import type { Sql } from "@/lib/db";
import { checkHeartbeats } from "@/lib/ingest";
import { notifyNewAlerts } from "@/lib/notify";
import { archiveOldEvents } from "@/lib/retention";
import { backfill, tick as simulatorTick } from "@/simulator/run";

export type TickResult = {
  at: string;
  simulated: number;
  polled: number;
  heartbeatFindings: number;
  evaluated: number;
  alertsCreated: number;
  integrityAlerts: number;
  notified: number;
  archived: number;
  errors: string[];
  durationMs: number;
};

const lock = globalThis as unknown as { __vigilTickLock?: Promise<unknown> };

/**
 * Serializes work that appends to event chains or advances cursors: the background loop, on-demand
 * scenario runs and manual ticks never overlap within a process.
 */
export function withWorkerLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (lock.__vigilTickLock ?? Promise.resolve()).then(fn);
  lock.__vigilTickLock = run.catch(() => undefined);
  return run;
}

export function workerTick(sql: Sql, now = new Date()): Promise<TickResult> {
  return withWorkerLock(() => tickOnce(sql, now));
}

async function tickOnce(sql: Sql, now: Date): Promise<TickResult> {
  const started = Date.now();
  const config = getConfig();
  const r: TickResult = { at: now.toISOString(), simulated: 0, polled: 0, heartbeatFindings: 0, evaluated: 0, alertsCreated: 0, integrityAlerts: 0, notified: 0, archived: 0, errors: [], durationMs: 0 };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      r.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`[worker] ${name} failed`, error);
    }
  };
  if (config.simulator) {
    await step("simulator", async () => {
      r.simulated += (await backfill(sql, now)).events;
      r.simulated += await simulatorTick(sql, now);
    });
  }
  await step("connector", async () => {
    r.polled = (await pollNexora(sql, now, { config })).stored;
  });
  await step("heartbeat", async () => {
    r.heartbeatFindings = await checkHeartbeats(sql, now);
  });
  await step("detection", async () => {
    const d = await runDetection(sql);
    r.evaluated = d.evaluated;
    r.alertsCreated = d.alertsCreated.length;
    r.integrityAlerts = (await runIntegrityAlerts(sql)).length;
  });
  await step("notifications", async () => {
    r.notified = await notifyNewAlerts(sql);
  });
  await step("retention", async () => {
    r.archived = (await archiveOldEvents(sql, now)).archived;
  });
  r.durationMs = Date.now() - started;
  await sql
    .query("insert into worker_state (name, value, updated_at) values ('worker', $1, now()) on conflict (name) do update set value = excluded.value, updated_at = now()", [JSON.stringify(r)])
    .catch(() => undefined);
  return r;
}

const g = globalThis as unknown as { __vigilWorker?: { timer: ReturnType<typeof setInterval>; running: boolean } };

/** Starts the periodic loop once per process; ticks never overlap. */
export function startWorker(getSqlFn: () => Promise<Sql>, intervalMs = 10_000): void {
  if (g.__vigilWorker) return;
  const state = { timer: null as unknown as ReturnType<typeof setInterval>, running: false };
  const run = async () => {
    if (state.running) return;
    state.running = true;
    try {
      const sql = await getSqlFn();
      await workerTick(sql);
    } catch (error) {
      console.error("[worker] tick failed", error);
    } finally {
      state.running = false;
    }
  };
  state.timer = setInterval(run, intervalMs);
  g.__vigilWorker = state;
  void (async () => {
    const sql = await getSqlFn();
    await bootstrap(sql);
    await run();
  })().catch((error) => console.error("[worker] start failed", error));
}
