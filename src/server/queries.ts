import "server-only";
import type { AlertRow } from "@/lib/alerts";
import type { Sql } from "@/lib/db";
import type { ConnectorState } from "@/lib/ingest";
import { connectorHealth } from "@/lib/connector";
import type { EventRow } from "@/detection/live";

export type StoredEvent = EventRow & { event_id: string; request_id: string | null; prev_hash: string; hash: string; raw: Record<string, unknown>; chain_ok: boolean; ingested_at: string };

export type IncidentRow = {
  id: string;
  title: string;
  severity: AlertRow["severity"];
  status: "new" | "triaged" | "investigating" | "resolved" | "false_positive";
  assignee_id: string | null;
  assignee_name?: string | null;
  group_key: string;
  simulated: boolean;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  alert_count?: number;
};

export const RANGES = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
export type RangeKey = keyof typeof RANGES;
export const rangeOf = (v: string | undefined): RangeKey => (v && v in RANGES ? (v as RangeKey) : "24h");

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overview(sql: Sql, range: RangeKey, now = new Date()) {
  const from = new Date(now.getTime() - RANGES[range]).toISOString();
  // Bucket size keeps ~60 points: per minute for 1h, coarser for longer ranges.
  const bucketMinutes = range === "1h" ? 1 : range === "24h" ? 30 : range === "7d" ? 180 : 720;
  const series = await sql.query<{ bucket: string; total: number; failures: number }>(
    `select to_timestamp(floor(extract(epoch from occurred_at) / ($2 * 60)) * ($2 * 60)) as bucket,
            count(*)::int as total, count(*) filter (where outcome = 'failure')::int as failures
     from events where occurred_at >= $1 group by 1 order by 1`,
    [from, bucketMinutes],
  );
  const [totals] = await sql.query<{ events: number; failures: number; per_minute: number }>(
    "select count(*)::int as events, count(*) filter (where outcome = 'failure')::int as failures, round(count(*)::numeric / greatest(1, extract(epoch from (now() - $1::timestamptz)) / 60), 2)::float as per_minute from events where occurred_at >= $1",
    [from],
  );
  const openBySeverity = await sql.query<{ severity: string; n: number }>("select severity, count(*)::int as n from alerts where status = 'open' group by severity");
  const topRules = await sql.query<{ rule_id: string; title: string; n: number; hits: number }>(
    "select rule_id, max(title) as title, count(*)::int as n, sum(count)::int as hits from alerts where last_seen_at >= $1 group by rule_id order by n desc, hits desc limit 6",
    [from],
  );
  const topIps = await sql.query<{ value: string; n: number; failures: number }>(
    "select source_ip as value, count(*)::int as n, count(*) filter (where outcome = 'failure')::int as failures from events where occurred_at >= $1 and source_ip is not null group by source_ip order by failures desc, n desc limit 6",
    [from],
  );
  const topActors = await sql.query<{ value: string; type: string; n: number; failures: number }>(
    "select actor_id as value, max(actor_type) as type, count(*)::int as n, count(*) filter (where outcome = 'failure')::int as failures from events where occurred_at >= $1 and actor_id is not null and actor_type <> 'service' group by actor_id order by failures desc, n desc limit 6",
    [from],
  );
  const incidents = await sql.query<{ status: string; n: number }>("select status, count(*)::int as n from incidents group by status");
  return { from, bucketMinutes, series, totals: totals!, openBySeverity, topRules, topIps, topActors, incidents, status: await systemStatus(sql, now) };
}

export async function systemStatus(sql: Sql, now = new Date()) {
  const sources = await sql.query<ConnectorState>("select * from connector_state order by source");
  const findings = await sql.query<{ source: string; kind: string; n: number; last: string }>("select source, kind, count(*)::int as n, max(detected_at) as last from integrity_findings group by source, kind");
  const worker = (await sql.query<{ value: Record<string, unknown>; updated_at: string }>("select value, updated_at from worker_state where name = 'worker'"))[0] ?? null;
  return {
    sources: sources.map((s) => ({
      ...s,
      lag_seconds: s.last_event_at ? Math.max(0, Math.round((now.getTime() - Date.parse(s.last_event_at)) / 1000)) : null,
      heartbeat_age_seconds: s.last_heartbeat_at ? Math.round((now.getTime() - Date.parse(s.last_heartbeat_at)) / 1000) : null,
      findings: findings.filter((f) => f.source === s.source),
    })),
    connector: await connectorHealth(sql),
    worker,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventFilters = {
  range: RangeKey;
  action?: string;
  category?: string;
  outcome?: string;
  severity?: string;
  actor?: string;
  ip?: string;
  target?: string;
  q?: string;
  source?: "nexora" | "simulator";
  page: number;
};

export const PAGE_SIZE = 50;

export async function listEvents(sql: Sql, f: EventFilters, now = new Date()) {
  const where: string[] = ["occurred_at >= $1"];
  const params: unknown[] = [new Date(now.getTime() - RANGES[f.range]).toISOString()];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };
  if (f.action) add("action = ?", f.action);
  if (f.category) add("category = ?", f.category);
  if (f.outcome) add("outcome = ?", f.outcome);
  if (f.severity) add("severity = ?", f.severity);
  if (f.actor) add("actor_id = ?", f.actor);
  if (f.ip) add("source_ip = ?", f.ip);
  if (f.target) add("target_id = ?", f.target);
  if (f.source) add("source = ?", f.source);
  if (f.q) add("(action ilike ? or coalesce(actor_id,'') ilike $X or coalesce(source_ip,'') ilike $X or coalesce(target_id,'') ilike $X or metadata::text ilike $X)", `%${f.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  const clause = where.join(" and ").replace(/\$X/g, `$${params.length}`);
  const [count] = await sql.query<{ n: number }>(`select count(*)::int as n from events where ${clause}`, params);
  const rows = await sql.query<StoredEvent>(`select * from events where ${clause} order by occurred_at desc, id desc limit ${PAGE_SIZE} offset ${(f.page - 1) * PAGE_SIZE}`, params);
  const facets = await sql.query<{ action: string; n: number }>(`select action, count(*)::int as n from events where ${clause} group by action order by n desc limit 40`, params);
  return { rows, total: count!.n, facets };
}

export async function getEvent(sql: Sql, id: number) {
  const event = (await sql.query<StoredEvent>("select * from events where id = $1", [id]))[0];
  if (!event) return null;
  const neighbours = await sql.query<StoredEvent>(
    "select * from events where source = $1 and organization_id = $2 and sequence between $3 - 2 and $3 + 2 order by sequence",
    [event.source, event.organization_id, event.sequence],
  );
  const alerts = await sql.query<AlertRow>("select * from alerts where event_ids @> $1::jsonb order by created_at desc limit 20", [JSON.stringify([id])]);
  return { event, neighbours, alerts };
}

// ---------------------------------------------------------------------------
// Alerts and incidents
// ---------------------------------------------------------------------------

export async function listAlerts(sql: Sql, f: { status?: string; severity?: string; rule?: string; page: number }) {
  const where: string[] = ["true"];
  const params: unknown[] = [];
  if (f.status) {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  if (f.severity) {
    params.push(f.severity);
    where.push(`severity = $${params.length}`);
  }
  if (f.rule) {
    params.push(f.rule);
    where.push(`rule_id = $${params.length}`);
  }
  const clause = where.join(" and ");
  const [count] = await sql.query<{ n: number }>(`select count(*)::int as n from alerts where ${clause}`, params);
  const rows = await sql.query<AlertRow>(`select * from alerts where ${clause} order by last_seen_at desc limit ${PAGE_SIZE} offset ${(f.page - 1) * PAGE_SIZE}`, params);
  return { rows, total: count!.n };
}

export async function listIncidents(sql: Sql, f: { status?: string; severity?: string; assignee?: string; page: number }) {
  const where: string[] = ["true"];
  const params: unknown[] = [];
  if (f.status === "open") where.push("i.status not in ('resolved', 'false_positive')");
  else if (f.status) {
    params.push(f.status);
    where.push(`i.status = $${params.length}`);
  }
  if (f.severity) {
    params.push(f.severity);
    where.push(`i.severity = $${params.length}`);
  }
  if (f.assignee === "none") where.push("i.assignee_id is null");
  else if (f.assignee) {
    params.push(f.assignee);
    where.push(`i.assignee_id = $${params.length}`);
  }
  const clause = where.join(" and ");
  const [count] = await sql.query<{ n: number }>(`select count(*)::int as n from incidents i where ${clause}`, params);
  const rows = await sql.query<IncidentRow>(
    `select i.*, u.name as assignee_name, (select count(*)::int from alerts a where a.incident_id = i.id) as alert_count
     from incidents i left join users u on u.id = i.assignee_id where ${clause}
     order by case i.severity when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end desc, i.updated_at desc
     limit ${PAGE_SIZE} offset ${(f.page - 1) * PAGE_SIZE}`,
    params,
  );
  return { rows, total: count!.n };
}

export type TimelineRow = { id: number; incident_id: string; at: string; kind: string; actor_id: string | null; actor_name: string | null; body: string; data: Record<string, unknown> };
export type ResponseRow = {
  id: string;
  incident_id: string;
  kind: "revoke_api_key" | "disable_user";
  target_id: string;
  target_label: string | null;
  status: "proposed" | "executed" | "failed" | "rejected";
  proposed_by: string | null;
  proposed_by_name: string | null;
  proposed_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  reason: string | null;
  simulated: boolean;
  request_summary: Record<string, unknown> | null;
  response_summary: Record<string, unknown> | null;
};

export async function getIncident(sql: Sql, id: string) {
  const incident = (await sql.query<IncidentRow>("select i.*, u.name as assignee_name from incidents i left join users u on u.id = i.assignee_id where i.id = $1", [id]))[0];
  if (!incident) return null;
  const alerts = await sql.query<AlertRow>("select * from alerts where incident_id = $1 order by first_seen_at", [id]);
  const timeline = await sql.query<TimelineRow>("select t.*, u.name as actor_name from incident_timeline t left join users u on u.id = t.actor_id where incident_id = $1 order by at, id", [id]);
  const responses = await sql.query<ResponseRow>(
    "select r.*, p.name as proposed_by_name, d.name as decided_by_name from response_actions r left join users p on p.id = r.proposed_by left join users d on d.id = r.decided_by where incident_id = $1 order by proposed_at",
    [id],
  );
  const eventIds = [...new Set(alerts.flatMap((a) => a.event_ids))].slice(-300);
  const events = eventIds.length ? await sql.query<StoredEvent>("select * from events where id = any($1::bigint[]) order by occurred_at, id", [eventIds]) : [];
  return { incident, alerts, timeline, responses, events };
}

export async function getAlert(sql: Sql, id: string) {
  return (await sql.query<AlertRow>("select * from alerts where id = $1", [id]))[0] ?? null;
}

export async function listUsers(sql: Sql) {
  return sql.query<{ id: string; email: string; name: string; role: "analyst" | "admin"; active: boolean; created_at: string; last_login_at: string | null }>(
    "select id, email, name, role, active, created_at, last_login_at from users order by created_at",
  );
}

export async function listAudit(sql: Sql, page: number) {
  const [count] = await sql.query<{ n: number }>("select count(*)::int as n from audit_log");
  const rows = await sql.query<{ id: number; at: string; actor_email: string | null; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown>; ip: string | null }>(
    `select * from audit_log order by at desc, id desc limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`,
  );
  return { rows, total: count!.n };
}
