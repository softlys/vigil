import type { SecurityEvent } from "@/domain/event-schema";
import type { NormEvent } from "@/detection/engine";
import type { Rule } from "@/detection/schema";
import { migrate, openSql, type Sql } from "@/lib/db";
import { builtInRules, seedRules } from "@/lib/rules-store";
import { seal, type Draft } from "@/simulator/generator";

export async function freshDb(): Promise<Sql> {
  const sql = await openSql({ dataDir: "memory://" });
  await migrate(sql);
  await seedRules(sql);
  return sql;
}

/** Converts sealed NEXORA events to normalized events (ids in order) for in-memory evaluation. */
export function normalize(events: SecurityEvent[], source: NormEvent["source"] = "simulator", firstId = 1): NormEvent[] {
  return events.map((e, i) => ({
    id: firstId + i,
    source,
    simulated: source === "simulator",
    organization_id: e.organization_id,
    sequence: e.sequence,
    occurred_at: e.occurred_at,
    action: e.action,
    category: e.category,
    outcome: e.outcome,
    severity: e.severity,
    actor: {
      type: e.actor.type,
      id: e.actor.type === "user" ? e.actor.user_id : e.actor.type === "api_key" ? e.actor.api_key_id : e.actor.type === "service" ? e.actor.name : null,
      role: e.actor.type === "user" ? e.actor.role : null,
    },
    source_info: { ip: e.source.ip, user_agent: e.source.user_agent },
    target: { type: e.target.type, id: e.target.id },
    metadata: e.metadata,
  }));
}

export function sorted(drafts: Draft[]): Draft[] {
  return [...drafts].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

export function sealDrafts(drafts: Draft[]): SecurityEvent[] {
  return seal(sorted(drafts), null);
}

export const RULES: Record<string, Rule> = Object.fromEntries(builtInRules().map((r) => [r.id, r]));
