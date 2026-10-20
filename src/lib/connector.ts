/**
 * NEXORA connector: polls GET {NEXORA_URL}/api/v1/security-events?after=<last sequence> with the
 * read key (scope security:read). The cursor is the last stored sequence (connector_state), so a
 * restart resumes exactly where it stopped and re-delivered events are ignored.
 * Errors back off exponentially (30 s → 15 min). A schema mismatch stops the connector and creates
 * an integrity finding, so a contract change is noticed instead of silently dropping events.
 */
import { connectorConfigured, getConfig, type VigilConfig } from "./config";
import type { Sql } from "./db";
import { getConnectorState, ingestEvents, parseEvents, SchemaMismatchError } from "./ingest";

export type ConnectorHealth = {
  organization_id: string | null;
  last_poll_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  next_attempt_at: string | null;
  last_batch: number;
  stopped_reason: string | null;
};

const EMPTY: ConnectorHealth = {
  organization_id: null,
  last_poll_at: null,
  last_success_at: null,
  last_error: null,
  last_error_at: null,
  consecutive_failures: 0,
  next_attempt_at: null,
  last_batch: 0,
  stopped_reason: null,
};

export async function connectorHealth(sql: Sql): Promise<ConnectorHealth> {
  const row = (await sql.query<{ value: ConnectorHealth }>("select value from worker_state where name = 'nexora_connector'"))[0];
  return { ...EMPTY, ...(row?.value ?? {}) };
}

async function saveHealth(sql: Sql, h: ConnectorHealth) {
  await sql.query("insert into worker_state (name, value, updated_at) values ('nexora_connector', $1, now()) on conflict (name) do update set value = excluded.value, updated_at = now()", [JSON.stringify(h)]);
}

export function backoffMs(failures: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
}

type Page = { data: unknown[]; meta: { next_after_sequence: number; has_more: boolean; last_sequence: number } };

export type PollResult = { ran: boolean; stored: number; pages: number; error: string | null };

export async function pollNexora(sql: Sql, now: Date, options: { config?: VigilConfig; fetchImpl?: typeof fetch; maxPages?: number; force?: boolean } = {}): Promise<PollResult> {
  const config = options.config ?? getConfig();
  if (!connectorConfigured(config)) return { ran: false, stored: 0, pages: 0, error: null };
  const health = await connectorHealth(sql);
  if (!options.force && (health.stopped_reason || (health.next_attempt_at && Date.parse(health.next_attempt_at) > now.getTime()))) return { ran: false, stored: 0, pages: 0, error: null };
  if (options.force) health.stopped_reason = null;
  const fetchImpl = options.fetchImpl ?? fetch;
  health.last_poll_at = now.toISOString();
  let stored = 0;
  let pages = 0;
  try {
    for (; pages < (options.maxPages ?? 10); ) {
      const after = health.organization_id ? (await getConnectorState(sql, "nexora", health.organization_id)).last_sequence : 0;
      const url = `${config.nexora.url}/api/v1/security-events?after=${after}&limit=${config.nexora.pageSize}`;
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.nexora.readKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
      pages += 1;
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`NEXORA answered HTTP ${res.status}: ${body}`);
      }
      const page = (await res.json()) as Page;
      if (!Array.isArray(page.data) || !page.meta) throw new SchemaMismatchError("The security-events response does not have { data, meta }", []);
      const events = parseEvents(page.data);
      if (events.length) {
        health.organization_id ??= events[0]!.organization_id;
        stored += (await ingestEvents(sql, "nexora", events)).stored;
      }
      if (!page.meta.has_more || events.length === 0) break;
    }
    health.last_success_at = now.toISOString();
    health.consecutive_failures = 0;
    health.next_attempt_at = new Date(now.getTime() + config.nexora.pollSeconds * 1000).toISOString();
    health.last_batch = stored;
    await saveHealth(sql, health);
    return { ran: true, stored, pages, error: null };
  } catch (error) {
    const message = error instanceof SchemaMismatchError ? `${error.message}. ${error.issues.join("; ")}` : error instanceof Error ? error.message : String(error);
    health.last_error = message.slice(0, 1000);
    health.last_error_at = now.toISOString();
    health.consecutive_failures += 1;
    health.next_attempt_at = new Date(now.getTime() + backoffMs(health.consecutive_failures)).toISOString();
    if (error instanceof SchemaMismatchError) {
      health.stopped_reason = "Schema mismatch: update VIGIL's copy of the NEXORA event schema, then restart the connector in Settings.";
      if (health.organization_id) {
        await sql.query("insert into integrity_findings (source, organization_id, kind, detail) values ('nexora', $1, 'schema_mismatch', $2)", [health.organization_id, health.last_error]);
      }
    }
    await saveHealth(sql, health);
    return { ran: true, stored, pages, error: health.last_error };
  }
}
