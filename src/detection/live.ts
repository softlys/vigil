/**
 * Live detection in the worker: evaluates enabled rules against events stored since the detection
 * cursor (worker_state 'detection'), and turns integrity findings into VGL-015-type alerts.
 */
import { evaluate, type History, type NormEvent, type Scope } from "./engine";
import { raiseAlert, hitToRaise, type AlertRow } from "@/lib/alerts";
import type { Sql } from "@/lib/db";
import { loadRules, type StoredRule } from "@/lib/rules-store";

export type EventRow = {
  id: number;
  source: "nexora" | "simulator";
  simulated: boolean;
  organization_id: string;
  sequence: number;
  occurred_at: string;
  action: string;
  category: string;
  outcome: string;
  severity: string;
  actor_type: string;
  actor_id: string | null;
  actor_role: string | null;
  source_ip: string | null;
  user_agent: string | null;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
};

/** Timestamps are compared as ISO strings; some driver paths hand back Date objects, so normalize. */
const iso = (v: unknown): string => (typeof v === "string" ? v : new Date(v as Date).toISOString());

export function toNorm(r: EventRow): NormEvent {
  return {
    id: r.id,
    source: r.source,
    simulated: r.simulated,
    organization_id: r.organization_id,
    sequence: r.sequence,
    occurred_at: iso(r.occurred_at),
    action: r.action,
    category: r.category,
    outcome: r.outcome,
    severity: r.severity,
    actor: { type: r.actor_type, id: r.actor_id, role: r.actor_role },
    source_info: { ip: r.source_ip, user_agent: r.user_agent },
    target: { type: r.target_type, id: r.target_id },
    metadata: r.metadata ?? {},
  };
}

/** SQL column (or JSON path) for a normalized field, for history lookups. */
function column(field: string): { expr: string } {
  const map: Record<string, string> = {
    action: "action",
    category: "category",
    outcome: "outcome",
    severity: "severity",
    organization_id: "organization_id::text",
    "actor.type": "actor_type",
    "actor.id": "actor_id",
    "actor.role": "actor_role",
    "source.ip": "source_ip",
    "source.user_agent": "user_agent",
    "target.type": "target_type",
    "target.id": "target_id",
  };
  if (map[field]) return { expr: map[field] };
  const parts = field.slice(9).split(".");
  // Field names are validated by FIELD_PATTERN ([a-z0-9_]), so interpolation is safe here.
  return { expr: parts.length === 1 ? `metadata->>'${parts[0]}'` : `metadata->'${parts[0]}'->>'${parts[1]}'` };
}

export class SqlHistory implements History {
  constructor(private sql: Sql) {}

  async between(scope: Scope, actions: string[] | null, from: string, to: string): Promise<NormEvent[]> {
    const rows = actions
      ? await this.sql.query<EventRow>(
          "select * from events where source = $1 and organization_id = $2 and action = any($3::text[]) and occurred_at between $4 and $5 order by occurred_at, id limit 5000",
          [scope.source, scope.organization_id, actions, from, to],
        )
      : await this.sql.query<EventRow>("select * from events where source = $1 and organization_id = $2 and occurred_at between $3 and $4 order by occurred_at, id limit 5000", [
          scope.source,
          scope.organization_id,
          from,
          to,
        ]);
    return rows.map(toNorm);
  }

  async everSeen(scope: Scope, actions: string[] | null, field: string, value: string, before: string, excludeId: number): Promise<boolean> {
    const col = column(field).expr;
    const params: unknown[] = [scope.source, scope.organization_id, value, before, excludeId];
    const actionClause = actions ? `and action = any($6::text[])` : "";
    if (actions) params.push(actions);
    const rows = await this.sql.query(`select 1 from events where source = $1 and organization_id = $2 and ${col} = $3 and occurred_at <= $4 and id <> $5 ${actionClause} limit 1`, params);
    return rows.length > 0;
  }

  async remember(ruleId: string, key: string, value: string, at: string) {
    const known = await this.sql.query("select 1 from rule_seen_values where rule_id = $1 and key = $2 limit 1", [ruleId, key]);
    const inserted = await this.sql.query("insert into rule_seen_values (rule_id, key, value, first_seen_at) values ($1, $2, $3, $4) on conflict do nothing returning 1", [ruleId, key, value, at]);
    return { isNew: inserted.length > 0, keyKnown: known.length > 0 };
  }
}

async function cursor(sql: Sql): Promise<number> {
  const row = (await sql.query<{ value: { last_event_id: number } }>("select value from worker_state where name = 'detection'"))[0];
  return row?.value.last_event_id ?? 0;
}

async function setCursor(sql: Sql, id: number) {
  await sql.query(
    "insert into worker_state (name, value, updated_at) values ('detection', $1, now()) on conflict (name) do update set value = excluded.value, updated_at = now()",
    [JSON.stringify({ last_event_id: id })],
  );
}

export type DetectionResult = { evaluated: number; alertsCreated: AlertRow[]; alertsUpdated: number };

/** Evaluates rules on events after the cursor, in id order, in batches. */
export async function runDetection(sql: Sql, options: { batch?: number; rules?: StoredRule[] } = {}): Promise<DetectionResult> {
  const result: DetectionResult = { evaluated: 0, alertsCreated: [], alertsUpdated: 0 };
  const rules = (options.rules ?? (await loadRules(sql))).filter((r) => r.enabled && r.definition.type !== "integrity");
  const history = new SqlHistory(sql);
  const batch = options.batch ?? 500;
  for (;;) {
    const after = await cursor(sql);
    const rows = await sql.query<EventRow>("select * from events where id > $1 order by id limit $2", [after, batch]);
    if (rows.length === 0) break;
    for (const row of rows) {
      const e = toNorm(row);
      for (const r of rules) {
        const hit = await evaluate(r.definition, e, history);
        if (!hit) continue;
        const { alert, created } = await raiseAlert(sql, hitToRaise(hit, r.version));
        if (created) result.alertsCreated.push(alert);
        else result.alertsUpdated += 1;
      }
      result.evaluated += 1;
    }
    await setCursor(sql, rows[rows.length - 1]!.id);
    if (rows.length < batch) break;
  }
  return result;
}

type FindingRow = { id: number; source: "nexora" | "simulator"; organization_id: string; kind: string; detail: string; sequence: number | null; detected_at: string };

/** Turns unprocessed integrity findings into alerts for enabled integrity rules. */
export async function runIntegrityAlerts(sql: Sql, options: { rules?: StoredRule[] } = {}): Promise<AlertRow[]> {
  const rules = (options.rules ?? (await loadRules(sql))).filter((r) => r.enabled && r.definition.type === "integrity");
  const findings = await sql.query<FindingRow>("select * from integrity_findings where processed = false order by id");
  const created: AlertRow[] = [];
  for (const f of findings) {
    for (const r of rules) {
      if (r.definition.type !== "integrity" || !(r.definition.kinds as string[]).includes(f.kind)) continue;
      const evidence = f.sequence === null ? [] : (await sql.query<{ id: number }>("select id from events where source = $1 and organization_id = $2 and sequence = $3", [f.source, f.organization_id, f.sequence])).map((x) => x.id);
      const { alert, created: isNew } = await raiseAlert(sql, {
        rule: r.definition,
        ruleVersion: r.version,
        key: f.organization_id,
        entity: { field: "organization_id", value: f.organization_id },
        eventIds: evidence,
        at: f.detected_at,
        // The finding detail already names its kind ("Sequence gap: expected …").
        summary: f.detail,
        simulated: f.source === "simulator",
        scope: `${f.source}:${f.organization_id}`,
      });
      if (isNew) created.push(alert);
    }
    await sql.query("update integrity_findings set processed = true where id = $1", [f.id]);
  }
  return created;
}
