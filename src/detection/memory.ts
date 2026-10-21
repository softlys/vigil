/** In-memory History for backtests and tests: evaluates rules over a list of events without side effects. */
import { actionsOf, asKey, evaluate, fieldValue, type Hit, type History, type NormEvent } from "./engine";
import type { Rule } from "./schema";

export class MemoryHistory implements History {
  private seen = new Map<string, Set<string>>();
  constructor(private events: NormEvent[] = []) {}

  add(e: NormEvent) {
    this.events.push(e);
  }

  async between(scope: { source: string; organization_id: string }, actions: string[] | null, from: string, to: string) {
    return this.events.filter(
      (e) => e.source === scope.source && e.organization_id === scope.organization_id && e.occurred_at >= from && e.occurred_at <= to && (!actions || actions.includes(e.action)),
    );
  }

  async everSeen(scope: { source: string; organization_id: string }, actions: string[] | null, field: string, value: string, before: string, excludeId: number) {
    return this.events.some(
      (e) => e.id !== excludeId && e.source === scope.source && e.organization_id === scope.organization_id && e.occurred_at <= before && (!actions || actions.includes(e.action)) && asKey(fieldValue(e, field)) === value,
    );
  }

  async remember(ruleId: string, key: string, value: string) {
    const k = `${ruleId}|${key}`;
    const set = this.seen.get(k) ?? new Set<string>();
    const isNew = !set.has(value);
    const keyKnown = set.size > 0;
    set.add(value);
    this.seen.set(k, set);
    return { isNew, keyKnown };
  }
}

/**
 * Replays stored events through one rule exactly like live detection does (src/detection/live.ts):
 * - events are evaluated in storage order (id), and history lookups see every stored event, just as
 *   the worker sees everything already ingested;
 * - repeated hits for the same source, organization and key within the dedup window are one alert
 *   (the live dedup key is `${source}:${organization}|${rule}|${key}`).
 * A test (tests/unit/pipeline.test.ts, "backtest matches live detection") keeps the two in step.
 */
export async function backtest(rule: Rule, events: NormEvent[], dedupWindowMs: number): Promise<Array<Hit & { count: number }>> {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const history = new MemoryHistory([...ordered].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id - b.id));
  const alerts: Array<Hit & { count: number; until: number; scope: string }> = [];
  for (const e of ordered) {
    const hit = await evaluate(rule, e, history);
    if (!hit) continue;
    const scope = `${e.source}:${e.organization_id}`;
    const at = Date.parse(hit.at);
    const open = alerts.findLast((a) => a.scope === scope && a.key === hit.key && a.until >= at);
    if (open) {
      open.count += 1;
      open.until = Math.max(open.until, at + dedupWindowMs);
      continue;
    }
    alerts.push({ ...hit, count: 1, until: at + dedupWindowMs, scope });
  }
  return alerts.map(({ until: _u, scope: _s, ...a }) => {
    void _u;
    void _s;
    return a;
  });
}

export { actionsOf };
