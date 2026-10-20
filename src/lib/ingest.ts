/**
 * Storing events: validate against the NEXORA schema, verify the hash chain against the stored
 * tail for that source and organization, then append. Integrity problems become findings (which
 * the worker turns into high-severity alerts); they never silently drop events.
 */
import { GENESIS_HASH, hashEvent, securityEventSchema, type SecurityEvent } from "@/domain/event-schema";
import type { Sql } from "./db";

export type EventSource = "nexora" | "simulator";

/** NEXORA writes a heartbeat every 5 minutes; silence longer than this is an integrity finding. */
export const HEARTBEAT_GAP_MS = 15 * 60_000;

export type ConnectorState = {
  source: EventSource;
  organization_id: string;
  last_sequence: number;
  last_hash: string;
  last_event_at: string | null;
  last_heartbeat_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  next_attempt_at: string | null;
  events_ingested: number;
};

export type IngestResult = { stored: number; duplicates: number; findings: Array<{ kind: string; detail: string }>; lastSequence: number };

export class SchemaMismatchError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = "SchemaMismatchError";
  }
}

/** Validates raw events; throws on the first mismatch with every issue listed. */
export function parseEvents(raw: unknown[]): SecurityEvent[] {
  return raw.map((r, i) => {
    const parsed = securityEventSchema.safeParse(r);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 10).map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`);
      const seq = (r as { sequence?: unknown })?.sequence;
      throw new SchemaMismatchError(`Event at index ${i} (sequence ${String(seq)}) does not match the NEXORA security event schema`, issues);
    }
    return parsed.data;
  });
}

export async function getConnectorState(sql: Sql, source: EventSource, orgId: string): Promise<ConnectorState> {
  const rows = await sql.query<ConnectorState>("select * from connector_state where source = $1 and organization_id = $2", [source, orgId]);
  if (rows[0]) return rows[0];
  await sql.query("insert into connector_state (source, organization_id) values ($1, $2) on conflict do nothing", [source, orgId]);
  return (await sql.query<ConnectorState>("select * from connector_state where source = $1 and organization_id = $2", [source, orgId]))[0]!;
}

function actorId(e: SecurityEvent): string | null {
  const a = e.actor;
  return a.type === "user" ? a.user_id : a.type === "api_key" ? a.api_key_id : a.type === "service" ? a.name : null;
}

/** Findings are dated at the event that revealed them, so history and alerts line up with the log. */
async function finding(sql: Sql, source: EventSource, orgId: string, kind: string, detail: string, e: SecurityEvent | null) {
  await sql.query("insert into integrity_findings (source, organization_id, kind, detail, sequence, event_id, detected_at) values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))", [
    source,
    orgId,
    kind,
    detail,
    e?.sequence ?? null,
    e?.event_id ?? null,
    e?.occurred_at ?? null,
  ]);
}

/**
 * Appends events for one source in sequence order. Each event is checked against the previous
 * stored event: missing sequence numbers, a prev_hash that does not point at the previous hash, or
 * a hash that does not match the content are recorded as findings. Re-delivered events (same
 * sequence already stored) are skipped, which makes polling and push idempotent.
 */
export async function ingestEvents(sql: Sql, source: EventSource, events: SecurityEvent[]): Promise<IngestResult> {
  const result: IngestResult = { stored: 0, duplicates: 0, findings: [], lastSequence: 0 };
  const byOrg = new Map<string, SecurityEvent[]>();
  for (const e of events) byOrg.set(e.organization_id, [...(byOrg.get(e.organization_id) ?? []), e]);

  for (const [orgId, list] of byOrg) {
    list.sort((a, b) => a.sequence - b.sequence);
    await sql.tx(async (q) => {
      const state = await getConnectorState(q, source, orgId);
      let lastSeq = state.last_sequence;
      let lastHash = state.last_hash || GENESIS_HASH;
      let lastHeartbeat = state.last_heartbeat_at;
      let lastAt = state.last_event_at;
      let stored = 0;
      for (const e of list) {
        if (e.sequence <= lastSeq) {
          // Re-delivery is normal; a different event at an already stored sequence means the
          // source's history was rewritten after VIGIL read it.
          const stored = (await q.query<{ hash: string }>("select hash from events where source = $1 and organization_id = $2 and sequence = $3", [source, orgId, e.sequence]))[0];
          if (stored && stored.hash !== e.hash) {
            const detail = `Conflicting event at sequence ${e.sequence}: the source now serves a different event than the one VIGIL stored. History was rewritten.`;
            const already = await q.query("select 1 from integrity_findings where source = $1 and organization_id = $2 and kind = 'chain_break' and sequence = $3 and detail like 'Conflicting%' limit 1", [source, orgId, e.sequence]);
            if (already.length === 0) {
              result.findings.push({ kind: "chain_break", detail });
              await finding(q, source, orgId, "chain_break", detail, e);
            }
          }
          result.duplicates += 1;
          continue;
        }
        let ok = true;
        if (e.sequence !== lastSeq + 1) {
          ok = false;
          const detail = `Sequence gap: expected ${lastSeq + 1}, received ${e.sequence} (${e.sequence - lastSeq - 1} event(s) missing).`;
          result.findings.push({ kind: "sequence_gap", detail });
          await finding(q, source, orgId, "sequence_gap", detail, e);
        } else if (e.prev_hash !== lastHash) {
          ok = false;
          const detail = `Chain break at sequence ${e.sequence}: prev_hash does not match the hash of sequence ${lastSeq}.`;
          result.findings.push({ kind: "chain_break", detail });
          await finding(q, source, orgId, "chain_break", detail, e);
        }
        const { hash, prev_hash, ...body } = e;
        if (hashEvent(prev_hash, body) !== hash) {
          ok = false;
          const detail = `Hash mismatch at sequence ${e.sequence}: the event content was modified after it was written.`;
          result.findings.push({ kind: "chain_break", detail });
          await finding(q, source, orgId, "chain_break", detail, e);
        }
        const inserted = await q.query<{ id: number }>(
          `insert into events (source, simulated, event_id, organization_id, sequence, occurred_at, category, action, outcome, severity,
             actor_type, actor_id, actor_role, source_ip, user_agent, request_id, target_type, target_id, metadata, prev_hash, hash, raw, chain_ok)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           on conflict (source, organization_id, sequence) do nothing returning id`,
          [
            source,
            source === "simulator",
            e.event_id,
            orgId,
            e.sequence,
            e.occurred_at,
            e.category,
            e.action,
            e.outcome,
            e.severity,
            e.actor.type,
            actorId(e),
            e.actor.type === "user" ? e.actor.role : null,
            e.source.ip,
            e.source.user_agent,
            e.source.request_id,
            e.target.type,
            e.target.id,
            JSON.stringify(e.metadata),
            prev_hash,
            hash,
            JSON.stringify(e),
            ok,
          ],
        );
        if (inserted.length === 0) {
          result.duplicates += 1;
          continue;
        }
        stored += 1;
        lastSeq = e.sequence;
        lastHash = hash;
        lastAt = !lastAt || e.occurred_at > lastAt ? e.occurred_at : lastAt;
        if (e.action === "system.heartbeat") {
          // A heartbeat that arrives after a long silence closes a past gap: record it as a finding.
          if (lastHeartbeat && Date.parse(e.occurred_at) - Date.parse(lastHeartbeat) > HEARTBEAT_GAP_MS) {
            const already = await q.query("select 1 from integrity_findings where source = $1 and organization_id = $2 and kind = 'heartbeat_gap' and detected_at >= $3 limit 1", [source, orgId, lastHeartbeat]);
            if (already.length === 0) {
              const minutes = Math.round((Date.parse(e.occurred_at) - Date.parse(lastHeartbeat)) / 60_000);
              const detail = `No system.heartbeat between ${lastHeartbeat} and ${e.occurred_at} (${minutes} minutes).`;
              result.findings.push({ kind: "heartbeat_gap", detail });
              await finding(q, source, orgId, "heartbeat_gap", detail, e);
            }
          }
          if (!lastHeartbeat || e.occurred_at > lastHeartbeat) lastHeartbeat = e.occurred_at;
        }
      }
      await q.query(
        `update connector_state set last_sequence = $3, last_hash = $4, last_event_at = $5, last_heartbeat_at = $6, events_ingested = events_ingested + $7
         where source = $1 and organization_id = $2`,
        [source, orgId, lastSeq, lastHash, lastAt, lastHeartbeat, stored],
      );
      result.stored += stored;
      result.lastSequence = Math.max(result.lastSequence, lastSeq);
    });
  }
  return result;
}

/** A heartbeat gap longer than `maxGapMinutes` (default 15) is an integrity finding, recorded once per gap. */
export async function checkHeartbeats(sql: Sql, now: Date, maxGapMinutes = 15): Promise<number> {
  const states = await sql.query<ConnectorState>("select * from connector_state");
  let count = 0;
  for (const s of states) {
    const since = s.last_heartbeat_at ?? s.last_event_at;
    if (!since) continue;
    const gapMin = (now.getTime() - Date.parse(since)) / 60_000;
    if (gapMin <= maxGapMinutes) continue;
    // One finding per silent period: skip if one was already recorded after the last heartbeat.
    const existing = await sql.query("select 1 from integrity_findings where source = $1 and organization_id = $2 and kind = 'heartbeat_gap' and detected_at > $3 limit 1", [s.source, s.organization_id, since]);
    if (existing.length) continue;
    await sql.query("insert into integrity_findings (source, organization_id, kind, detail, detected_at) values ($1, $2, 'heartbeat_gap', $3, $4)", [
      s.source,
      s.organization_id,
      `No system.heartbeat for ${Math.floor(gapMin)} minutes (last ${since}). The NEXORA scheduler may be stopped, or events are being suppressed.`,
      now.toISOString(),
    ]);
    count += 1;
  }
  return count;
}
