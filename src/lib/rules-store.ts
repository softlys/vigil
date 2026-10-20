/**
 * Rule storage. Built-in rules live as JSON files in rules/ (versioned in Git) and are loaded into
 * the database on first start. Edits made in the UI create a new version in the database
 * (rule_versions keeps every version) and are written to the audit log by the caller.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateRule, type Rule } from "@/detection/schema";
import type { Sql } from "./db";

export type StoredRule = { id: string; version: number; enabled: boolean; definition: Rule; updated_by: string | null; updated_at: string };

export function builtInRules(dir = join(/*turbopackIgnore: true*/ process.cwd(), "rules")): Rule[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const parsed = validateRule(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (!parsed.ok) throw new Error(`Built-in rule ${f} is invalid: ${parsed.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
      return parsed.rule;
    });
}

/** Inserts built-in rules that are not in the database yet. Existing (possibly edited) rules are kept. */
export async function seedRules(sql: Sql, rules: Rule[] = builtInRules()): Promise<number> {
  let added = 0;
  for (const r of rules) {
    const inserted = await sql.query("insert into rules (id, version, enabled, definition) values ($1, 1, true, $2) on conflict (id) do nothing returning id", [r.id, JSON.stringify(r)]);
    if (inserted.length) {
      await sql.query("insert into rule_versions (rule_id, version, definition) values ($1, 1, $2) on conflict do nothing", [r.id, JSON.stringify(r)]);
      added += 1;
    }
  }
  return added;
}

export async function loadRules(sql: Sql): Promise<StoredRule[]> {
  return sql.query<StoredRule>("select * from rules order by id");
}

export async function getRule(sql: Sql, id: string): Promise<StoredRule | null> {
  return (await sql.query<StoredRule>("select * from rules where id = $1", [id]))[0] ?? null;
}

export async function ruleVersions(sql: Sql, id: string) {
  return sql.query<{ version: number; definition: Rule; changed_by: string | null; changed_at: string }>("select version, definition, changed_by, changed_at from rule_versions where rule_id = $1 order by version desc", [id]);
}

export class RuleValidationError extends Error {
  constructor(public readonly issues: Array<{ path: string; message: string }>) {
    super(issues[0] ? `${issues[0].path}: ${issues[0].message}` : "Invalid rule");
  }
}

/** Saves a new version of a rule. The id and type cannot change. */
export async function saveRule(sql: Sql, id: string, definition: unknown, userId: string): Promise<StoredRule> {
  const parsed = validateRule(definition);
  if (!parsed.ok) throw new RuleValidationError(parsed.issues);
  const current = await getRule(sql, id);
  if (!current) throw new Error("Rule not found");
  if (parsed.rule.id !== id) throw new RuleValidationError([{ path: "id", message: "The rule id cannot change" }]);
  if (parsed.rule.type !== current.definition.type) throw new RuleValidationError([{ path: "type", message: "The rule type cannot change; create a new rule instead" }]);
  return sql.tx(async (q) => {
    const version = current.version + 1;
    const row = (
      await q.query<StoredRule>("update rules set version = $2, definition = $3, updated_by = $4, updated_at = now() where id = $1 returning *", [id, version, JSON.stringify(parsed.rule), userId])
    )[0]!;
    await q.query("insert into rule_versions (rule_id, version, definition, changed_by) values ($1, $2, $3, $4)", [id, version, JSON.stringify(parsed.rule), userId]);
    return row;
  });
}

export async function setRuleEnabled(sql: Sql, id: string, enabled: boolean, userId: string): Promise<StoredRule> {
  const row = (await sql.query<StoredRule>("update rules set enabled = $2, updated_by = $3, updated_at = now() where id = $1 returning *", [id, enabled, userId]))[0];
  if (!row) throw new Error("Rule not found");
  return row;
}
