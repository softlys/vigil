/**
 * Alerts and incidents.
 * - Dedup: a hit for the same rule and key while the previous alert's window is open updates that
 *   alert (count, last seen, events) instead of creating another one.
 * - Grouping: a new alert joins the open incident about the same entity (group key) from the last
 *   24 hours, otherwise it opens a new incident. Incident severity is the highest of its alerts.
 */
import { randomUUID } from "node:crypto";
import type { Hit } from "@/detection/engine";
import { durationMs, type Rule, type Severity } from "@/detection/schema";
import type { Sql } from "./db";

export type AlertRow = {
  id: string;
  rule_id: string;
  rule_version: number;
  title: string;
  severity: Severity;
  status: "open" | "closed";
  dedup_key: string;
  group_key: string;
  entity_type: string | null;
  entity_value: string | null;
  mitre: Array<{ id: string; name: string; tactic: string }>;
  first_seen_at: string;
  last_seen_at: string;
  window_ends_at: string;
  count: number;
  event_ids: number[];
  summary: string;
  simulated: boolean;
  incident_id: string | null;
  notified_at: string | null;
  created_at: string;
};

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
export const maxSeverity = (a: Severity, b: Severity): Severity => (RANK[a] >= RANK[b] ? a : b);
const GROUP_WINDOW_MS = 24 * 3_600_000;
const MAX_EVENT_IDS = 200;

export type RaiseInput = {
  rule: Rule;
  ruleVersion: number;
  key: string;
  entity: { field: string; value: string | null };
  eventIds: number[];
  at: string;
  summary: string;
  simulated: boolean;
  /** Scope prefix so simulated and real events never share alerts or incidents. */
  scope: string;
};

export type RaiseResult = { alert: AlertRow; created: boolean };

export async function raiseAlert(sql: Sql, input: RaiseInput): Promise<RaiseResult> {
  return sql.tx(async (q) => {
    const dedupKey = `${input.scope}|${input.rule.id}|${input.key}`;
    const open = (
      await q.query<AlertRow>("select * from alerts where dedup_key = $1 and status = 'open' and window_ends_at >= $2 order by created_at desc limit 1", [dedupKey, input.at])
    )[0];
    const windowEnds = new Date(Date.parse(input.at) + durationMs(input.rule.dedup_window)).toISOString();
    if (open) {
      const ids = [...new Set([...open.event_ids, ...input.eventIds])].slice(-MAX_EVENT_IDS);
      const updated = (
        await q.query<AlertRow>(
          "update alerts set count = count + 1, last_seen_at = greatest(last_seen_at, $2::timestamptz), window_ends_at = greatest(window_ends_at, $3::timestamptz), event_ids = $4::jsonb, summary = $5 where id = $1 returning *",
          [open.id, input.at, windowEnds, JSON.stringify(ids), input.summary],
        )
      )[0]!;
      return { alert: updated, created: false };
    }

    const groupKey = `${input.scope}|${input.entity.field}|${input.entity.value ?? input.key}`;
    const since = new Date(Date.parse(input.at) - GROUP_WINDOW_MS).toISOString();
    let incident = (
      await q.query<{ id: string; severity: Severity }>(
        "select id, severity from incidents where group_key = $1 and status not in ('resolved', 'false_positive') and updated_at >= $2 order by updated_at desc limit 1",
        [groupKey, since],
      )
    )[0];
    if (!incident) {
      const id = randomUUID();
      const entityLabel = input.entity.value ? `${input.entity.field.replace(/^metadata\./, "")} ${input.entity.value}` : input.key;
      await q.query("insert into incidents (id, title, severity, status, group_key, simulated, created_at, updated_at) values ($1, $2, $3, 'new', $4, $5, $6, $6)", [
        id,
        `${input.rule.title} (${entityLabel})`,
        input.rule.severity,
        groupKey,
        input.simulated,
        input.at,
      ]);
      await q.query("insert into incident_timeline (incident_id, at, kind, body, data) values ($1, $2, 'created', $3, $4)", [id, input.at, `Incident opened by rule ${input.rule.id}.`, JSON.stringify({ rule_id: input.rule.id })]);
      incident = { id, severity: input.rule.severity };
    } else {
      await q.query("update incidents set severity = $2, updated_at = greatest(updated_at, $3::timestamptz) where id = $1", [incident.id, maxSeverity(incident.severity, input.rule.severity), input.at]);
    }

    const alert = (
      await q.query<AlertRow>(
        `insert into alerts (id, rule_id, rule_version, title, severity, status, dedup_key, group_key, entity_type, entity_value, mitre, first_seen_at, last_seen_at,
           window_ends_at, count, event_ids, summary, simulated, incident_id)
         values ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$11,$11,$12,1,$13,$14,$15,$16) returning *`,
        [
          randomUUID(),
          input.rule.id,
          input.ruleVersion,
          input.rule.title,
          input.rule.severity,
          dedupKey,
          groupKey,
          input.entity.field,
          input.entity.value,
          JSON.stringify(input.rule.mitre),
          input.at,
          windowEnds,
          JSON.stringify(input.eventIds.slice(-MAX_EVENT_IDS)),
          input.summary,
          input.simulated,
          incident.id,
        ],
      )
    )[0]!;
    await q.query("insert into incident_timeline (incident_id, at, kind, body, data) values ($1, $2, 'alert', $3, $4)", [
      incident.id,
      input.at,
      `${input.rule.id} ${input.rule.title}: ${input.summary}`,
      JSON.stringify({ alert_id: alert.id, rule_id: input.rule.id, severity: input.rule.severity }),
    ]);
    return { alert, created: true };
  });
}

export function hitToRaise(hit: Hit, ruleVersion: number): RaiseInput {
  const first = hit.events[0]!;
  return {
    rule: hit.rule,
    ruleVersion,
    key: hit.key,
    entity: hit.entity,
    eventIds: hit.events.map((e) => e.id),
    at: hit.at,
    summary: hit.summary,
    simulated: first.simulated,
    scope: `${first.source}:${first.organization_id}`,
  };
}
