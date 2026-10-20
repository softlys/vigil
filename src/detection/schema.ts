/**
 * Detection rule format (JSON, versioned; inspired by Sigma). A rule has a filter over normalized
 * event fields and one of these types:
 *   single     every matching event raises (optionally: only outside working hours, or above the
 *              actor's own baseline for a numeric field)
 *   threshold  at least `count` matching events (or distinct values) per group within a window
 *   sequence   events matching step A, then step B, … by the same key within a window
 *   new_value  first time a value is seen for a key (the very first value per key is learned silently)
 *   integrity  hash-chain breaks, sequence gaps and heartbeat gaps found during ingestion
 * docs/detection-rules.md describes each built-in rule.
 */
import { z } from "zod";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Fields a filter may reference. `metadata.*` is free-form NEXORA metadata. */
export const FIELD_PATTERN = /^(action|category|outcome|severity|organization_id|actor\.(type|id|role)|source\.(ip|user_agent)|target\.(type|id)|metadata\.[a-z0-9_]+(\.[a-z0-9_]+)?)$/;
const field = z.string().regex(FIELD_PATTERN, "Unknown field. Use action, category, outcome, severity, actor.*, source.*, target.* or metadata.<name>");

const scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
export const conditionSchema = z.union([
  scalar,
  z.object({ in: z.array(scalar).min(1).max(50) }).strict(),
  z.object({ not_in: z.array(scalar).min(1).max(50) }).strict(),
  z.object({ neq: scalar }).strict(),
  z.object({ gte: z.number() }).strict(),
  z.object({ lte: z.number() }).strict(),
  z.object({ exists: z.boolean() }).strict(),
  z.object({ starts_with: z.string().min(1).max(100) }).strict(),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const filterSchema = z.record(field, conditionSchema).refine((f) => Object.keys(f).length > 0 && Object.keys(f).length <= 12, "1–12 conditions");
export type Filter = z.infer<typeof filterSchema>;

/** Durations like "90s", "10m", "2h", "7d". */
export const durationSchema = z.string().regex(/^\d{1,4}[smhd]$/, "Use a duration like 90s, 10m, 2h or 7d");
export function durationMs(d: string): number {
  const n = Number(d.slice(0, -1));
  const unit = d.slice(-1);
  return n * (unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

const mitreSchema = z
  .object({
    id: z.string().regex(/^T\d{4}(\.\d{3})?$/, "ATT&CK technique ids look like T1110 or T1110.003"),
    name: z.string().min(1).max(120),
    tactic: z.string().min(1).max(60),
  })
  .strict();

const base = {
  id: z.string().regex(/^[A-Z]{2,5}-\d{3}$/, "Rule ids look like VGL-001"),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(1000),
  severity: z.enum(SEVERITIES),
  mitre: z.array(mitreSchema).max(5),
  /** Which field identifies the entity an alert is about (used for dedup and incident grouping). */
  entity: field,
  /** Repeated hits for the same rule and entity within this window update one alert. */
  dedup_window: durationSchema.default("1h"),
  false_positives: z.array(z.string().max(300)).max(10).default([]),
  tuning: z.string().max(1000).default(""),
};

export const workingHoursSchema = z
  .object({ start_hour: z.number().int().min(0).max(23), end_hour: z.number().int().min(1).max(24), weekdays_only: z.boolean(), utc_offset_minutes: z.number().int().min(-720).max(840) })
  .strict();

export const ruleSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("single"),
      query: filterSchema,
      /** Only events outside these working hours raise. */
      outside_hours: workingHoursSchema.optional(),
      /** Only events whose numeric field exceeds `factor` × the actor's median over the lookback. */
      baseline: z
        .object({ field: field, by: field, lookback: durationSchema, factor: z.number().min(1).max(100), min_samples: z.number().int().min(1).max(100), min_value: z.number().min(0).default(0) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("threshold"),
      query: filterSchema,
      group_by: field,
      window: durationSchema,
      count: z.number().int().min(2).max(10_000),
      /** Count distinct values of this field instead of events. */
      distinct: field.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("sequence"),
      by: field,
      window: durationSchema,
      steps: z
        .array(
          z
            .object({
              name: z.string().min(1).max(60),
              query: filterSchema,
              min_count: z.number().int().min(1).max(1000).default(1),
              /** The step matches only if this field's value was never seen before in matching events. */
              first_seen: field.optional(),
            })
            .strict(),
        )
        .min(2)
        .max(4),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("new_value"),
      query: filterSchema,
      key: field,
      value: field,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("integrity"),
      kinds: z.array(z.enum(["chain_break", "sequence_gap", "heartbeat_gap", "schema_mismatch"])).min(1),
    })
    .strict(),
]);
export type Rule = z.infer<typeof ruleSchema>;
export type RuleType = Rule["type"];

export function validateRule(input: unknown): { ok: true; rule: Rule } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const parsed = ruleSchema.safeParse(input);
  if (parsed.success) {
    const r = parsed.data;
    if (r.type === "threshold" && durationMs(r.window) > 7 * 86_400_000) return { ok: false, issues: [{ path: "window", message: "Windows are limited to 7 days" }] };
    if (r.type === "sequence" && durationMs(r.window) > 7 * 86_400_000) return { ok: false, issues: [{ path: "window", message: "Windows are limited to 7 days" }] };
    return { ok: true, rule: r };
  }
  return { ok: false, issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) };
}
