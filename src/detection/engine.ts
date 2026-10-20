/**
 * Rule evaluation. Pure logic over normalized events; history access goes through the `History`
 * interface, implemented with SQL for live detection (src/detection/live.ts) and in memory for
 * backtests and tests (src/detection/memory.ts). The same code path runs in both.
 */
import { durationMs, type Condition, type Filter, type Rule } from "./schema";

export type NormEvent = {
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
  actor: { type: string; id: string | null; role: string | null };
  source_info: { ip: string | null; user_agent: string | null };
  target: { type: string | null; id: string | null };
  metadata: Record<string, unknown>;
};

export interface History {
  /** Events of the same source and organization in [from, to], oldest first, limited to `actions` when given. */
  between(scope: Scope, actions: string[] | null, from: string, to: string): Promise<NormEvent[]>;
  /** Whether any matching earlier event (before `before`) had this field value. */
  everSeen(scope: Scope, actions: string[] | null, field: string, value: string, before: string, excludeId: number): Promise<boolean>;
  /** New-value memory: records the value and reports whether it is new and whether the key had values before. */
  remember(ruleId: string, key: string, value: string, at: string): Promise<{ isNew: boolean; keyKnown: boolean }>;
}

export type Scope = { source: NormEvent["source"]; organization_id: string };

export type Hit = {
  rule: Rule;
  /** Dedup key within the rule: usually the entity value. */
  key: string;
  entity: { field: string; value: string | null };
  events: NormEvent[];
  at: string;
  summary: string;
};

// ---------------------------------------------------------------------------
// Fields and filters
// ---------------------------------------------------------------------------

export function fieldValue(e: NormEvent, path: string): unknown {
  switch (path) {
    case "action":
    case "category":
    case "outcome":
    case "severity":
    case "organization_id":
      return e[path];
    case "actor.type":
      return e.actor.type;
    case "actor.id":
      return e.actor.id;
    case "actor.role":
      return e.actor.role;
    case "source.ip":
      return e.source_info.ip;
    case "source.user_agent":
      return e.source_info.user_agent;
    case "target.type":
      return e.target.type;
    case "target.id":
      return e.target.id;
  }
  if (path.startsWith("metadata.")) {
    let v: unknown = e.metadata;
    for (const part of path.slice(9).split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined;
    return v;
  }
  return undefined;
}

export function asKey(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function conditionMatches(value: unknown, c: Condition): boolean {
  if (c === null || typeof c !== "object") return c === null ? value === null || value === undefined : value === c;
  if ("in" in c) return c.in.some((x) => x === value);
  if ("not_in" in c) return !c.not_in.some((x) => x === value);
  if ("neq" in c) return value !== c.neq;
  if ("gte" in c) return typeof value === "number" && value >= c.gte;
  if ("lte" in c) return typeof value === "number" && value <= c.lte;
  if ("exists" in c) return (value !== null && value !== undefined) === c.exists;
  if ("starts_with" in c) return typeof value === "string" && value.startsWith(c.starts_with);
  return false;
}

export function matches(e: NormEvent, filter: Filter): boolean {
  return Object.entries(filter).every(([path, c]) => conditionMatches(fieldValue(e, path), c));
}

/** The actions a filter can match, for index-friendly history queries (null = any). */
export function actionsOf(filter: Filter): string[] | null {
  const c = filter.action;
  if (typeof c === "string") return [c];
  if (c && typeof c === "object" && "in" in c) return c.in.filter((x): x is string => typeof x === "string");
  return null;
}

function unionActions(filters: Filter[]): string[] | null {
  const all: string[] = [];
  for (const f of filters) {
    const a = actionsOf(f);
    if (!a) return null;
    all.push(...a);
  }
  return [...new Set(all)];
}

function isoMinus(at: string, ms: number): string {
  return new Date(Date.parse(at) - ms).toISOString();
}

/** True when the event time falls outside the configured working hours. */
export function outsideHours(at: string, h: { start_hour: number; end_hour: number; weekdays_only: boolean; utc_offset_minutes: number }): boolean {
  const local = new Date(Date.parse(at) + h.utc_offset_minutes * 60_000);
  const day = local.getUTCDay();
  const hour = local.getUTCHours();
  if (h.weekdays_only && (day === 0 || day === 6)) return true;
  return hour < h.start_hour || hour >= h.end_hour;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Evaluation of one new event
// ---------------------------------------------------------------------------

export async function evaluate(rule: Rule, e: NormEvent, history: History): Promise<Hit | null> {
  if (rule.type === "integrity") return null; // raised from integrity findings, not from events
  const scope: Scope = { source: e.source, organization_id: e.organization_id };
  const entityValue = asKey(fieldValue(e, rule.entity));
  const hit = (events: NormEvent[], summary: string, key = entityValue ?? `event:${e.id}`): Hit => ({ rule, key, entity: { field: rule.entity, value: entityValue }, events, at: e.occurred_at, summary });

  switch (rule.type) {
    case "single": {
      if (!matches(e, rule.query)) return null;
      if (rule.outside_hours && !outsideHours(e.occurred_at, rule.outside_hours)) return null;
      if (rule.baseline) {
        const b = rule.baseline;
        const value = Number(fieldValue(e, b.field));
        const by = asKey(fieldValue(e, b.by));
        if (!Number.isFinite(value) || by === null || value < b.min_value) return null;
        const past = (await history.between(scope, actionsOf(rule.query), isoMinus(e.occurred_at, durationMs(b.lookback)), e.occurred_at)).filter(
          (x) => x.id !== e.id && matches(x, rule.query) && asKey(fieldValue(x, b.by)) === by && Number.isFinite(Number(fieldValue(x, b.field))),
        );
        if (past.length < b.min_samples) return null; // still learning this actor's normal volume
        const m = median(past.map((x) => Number(fieldValue(x, b.field))));
        if (value <= m * b.factor) return null;
        return hit([e], `${rule.title}: ${by} read ${value} records, ${(value / Math.max(m, 1)).toFixed(1)}× their median of ${m} over ${b.lookback}`);
      }
      return hit([e], `${rule.title}${entityValue ? `: ${entityValue}` : ""}`);
    }

    case "threshold": {
      if (!matches(e, rule.query)) return null;
      const group = asKey(fieldValue(e, rule.group_by));
      if (group === null) return null;
      const window = (await history.between(scope, actionsOf(rule.query), isoMinus(e.occurred_at, durationMs(rule.window)), e.occurred_at)).filter(
        (x) => matches(x, rule.query) && asKey(fieldValue(x, rule.group_by)) === group,
      );
      if (!window.some((x) => x.id === e.id)) window.push(e);
      const measure = rule.distinct ? new Set(window.map((x) => asKey(fieldValue(x, rule.distinct!))).filter((v) => v !== null)).size : window.length;
      if (measure < rule.count) return null;
      const what = rule.distinct ? `${measure} distinct ${rule.distinct.replace(/^metadata\./, "")} values` : `${measure} events`;
      return hit(window, `${rule.title}: ${what} for ${rule.group_by.replace(/^metadata\./, "")} ${group} within ${rule.window}`, group);
    }

    case "sequence": {
      const last = rule.steps[rule.steps.length - 1]!;
      if (!matches(e, last.query)) return null;
      const by = asKey(fieldValue(e, rule.by));
      if (by === null) return null;
      if (last.first_seen) {
        const v = asKey(fieldValue(e, last.first_seen));
        if (v === null || (await history.everSeen(scope, actionsOf(last.query), last.first_seen, v, e.occurred_at, e.id))) return null;
      }
      const from = isoMinus(e.occurred_at, durationMs(rule.window));
      const candidates = (await history.between(scope, unionActions(rule.steps.map((s) => s.query)), from, e.occurred_at)).filter((x) => x.id !== e.id && asKey(fieldValue(x, rule.by)) === by);
      const chain: NormEvent[] = [];
      let after = "";
      for (const step of rule.steps.slice(0, -1)) {
        const ms = candidates.filter((x) => x.occurred_at >= after && matches(x, step.query) && (chain.length === 0 || x.id !== chain[chain.length - 1]!.id));
        if (ms.length < step.min_count) return null;
        const used = ms.slice(0, step.min_count);
        chain.push(...used);
        after = used[used.length - 1]!.occurred_at;
      }
      if (e.occurred_at < after) return null;
      if (last.min_count > 1) {
        const finals = candidates.filter((x) => x.occurred_at >= after && matches(x, last.query));
        if (finals.length + 1 < last.min_count) return null;
        chain.push(...finals);
      }
      chain.push(e);
      return hit(chain, `${rule.title}: ${rule.steps.map((s) => s.name).join(" → ")} by ${rule.by.replace(/^metadata\./, "")} ${by} within ${rule.window}`, by);
    }

    case "new_value": {
      if (!matches(e, rule.query)) return null;
      const key = asKey(fieldValue(e, rule.key));
      const value = asKey(fieldValue(e, rule.value));
      if (key === null || value === null) return null;
      const { isNew, keyKnown } = await history.remember(rule.id, key, value, e.occurred_at);
      if (!isNew || !keyKnown) return null; // the first value per key is learned, not alerted
      return hit([e], `${rule.title}: ${rule.value.replace(/^metadata\./, "")} ${value} first seen for ${rule.key.replace(/^metadata\./, "")} ${key}`, `${key}|${value}`);
    }
  }
}
