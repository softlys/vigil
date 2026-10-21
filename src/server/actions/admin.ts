"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { durationMs } from "@/detection/schema";
import { backtest } from "@/detection/memory";
import { toNorm, type EventRow } from "@/detection/live";
import { audit } from "@/lib/audit";
import { pollNexora } from "@/lib/connector";
import { channels, deliver, type ChannelKey } from "@/lib/notify";
import { hashPassword } from "@/lib/passwords";
import { archiveOldEvents } from "@/lib/retention";
import { getRule, RuleValidationError, saveRule, setRuleEnabled } from "@/lib/rules-store";
import { runScenario, SCENARIOS } from "@/simulator/run";
import { getConfig } from "@/lib/config";
import { withWorkerLock, workerTick } from "@/worker/loop";
import { action, ActionError } from "../action";

// ---------------------------------------------------------------------------
// Rules (admin)
// ---------------------------------------------------------------------------

/**
 * Turning a rule off needs a reason (it is a blind spot until someone turns it back on).
 * Integrity rules cannot be turned off: they are how tampering with the event stream is noticed.
 */
export async function setRuleEnabledAction(input: unknown) {
  const schema = z
    .object({ id: z.string().max(20), enabled: z.boolean(), reason: z.string().trim().max(500).default("") })
    .strict()
    .refine((d) => d.enabled || d.reason.length >= 5, { path: ["reason"], message: "Explain why the rule is turned off (at least 5 characters)" });
  return action({ role: "admin", schema }, input, async ({ sql, user }, d) => {
    const current = await getRule(sql, d.id);
    if (!current) throw new ActionError("Rule not found.");
    if (!d.enabled && current.definition.type === "integrity") throw new ActionError("Integrity rules are always on: they detect gaps and tampering in the event stream.");
    if (current.enabled === d.enabled) return undefined;
    const rule = await setRuleEnabled(sql, d.id, d.enabled, user.id);
    await audit(sql, user, d.enabled ? "rule.enabled" : "rule.disabled", { type: "rule", id: d.id }, { version: rule.version, ...(d.enabled ? {} : { reason: d.reason }) });
    revalidatePath("/rules");
    revalidatePath(`/rules/${d.id}`);
    return undefined;
  });
}

export async function saveRuleAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ id: z.string().max(20), json: z.string().max(20_000) }).strict() }, input, async ({ sql, user }, d) => {
    const definition = parseJson(d.json);
    if (!definition.ok) return { issues: [definition.issue] };
    const before = await getRule(sql, d.id);
    try {
      const saved = await saveRule(sql, d.id, definition.value, user.id);
      await audit(sql, user, "rule.updated", { type: "rule", id: d.id }, { from_version: before?.version, to_version: saved.version });
      revalidatePath("/rules");
      revalidatePath(`/rules/${d.id}`);
      return { version: saved.version };
    } catch (error) {
      if (error instanceof RuleValidationError) return { issues: error.issues };
      throw error;
    }
  });
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; issue: { path: string; message: string } } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, issue: { path: "(json)", message: `This is not valid JSON: ${error instanceof Error ? error.message : "parse error"}` } };
  }
}

/** Restores an earlier version by saving its definition as a new version (history is never rewritten). */
export async function restoreRuleVersionAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ id: z.string().max(20), version: z.number().int().min(1) }).strict() }, input, async ({ sql, user }, d) => {
    const row = (await sql.query<{ definition: unknown }>("select definition from rule_versions where rule_id = $1 and version = $2", [d.id, d.version]))[0];
    if (!row) throw new ActionError("That version does not exist.");
    const before = await getRule(sql, d.id);
    if (before?.version === d.version) throw new ActionError("This is already the current version.");
    try {
      const saved = await saveRule(sql, d.id, row.definition, user.id);
      await audit(sql, user, "rule.restored", { type: "rule", id: d.id }, { from_version: before?.version, restored_version: d.version, to_version: saved.version });
      revalidatePath("/rules");
      revalidatePath(`/rules/${d.id}`);
      return { version: saved.version };
    } catch (error) {
      if (error instanceof RuleValidationError) throw new ActionError(`Version ${d.version} no longer passes validation: ${error.message}`);
      throw error;
    }
  });
}

/** Runs a rule (saved or the edited draft) over stored history without creating alerts. */
export async function backtestAction(input: unknown) {
  return action({ schema: z.object({ id: z.string().max(20), json: z.string().max(20_000).optional(), days: z.number().int().min(1).max(30) }).strict() }, input, async ({ sql }, d) => {
    const { validateRule } = await import("@/detection/schema");
    const stored = await getRule(sql, d.id);
    if (!stored) throw new ActionError("Rule not found.");
    let rule = stored.definition;
    if (d.json) {
      const json = parseJson(d.json);
      if (!json.ok) return { issues: [json.issue], hits: [], evaluated: 0, truncated: false };
      const parsed = validateRule(json.value);
      if (!parsed.ok) return { issues: parsed.issues, hits: [], evaluated: 0, truncated: false };
      rule = parsed.rule;
    }
    if (rule.type === "integrity") {
      const findings = await sql.query<{ kind: string; detail: string; detected_at: string; source: string }>(
        "select kind, detail, detected_at, source from integrity_findings where detected_at >= now() - ($1 || ' days')::interval order by detected_at desc limit 100",
        [String(d.days)],
      );
      return { issues: [], evaluated: findings.length, truncated: false, hits: findings.filter((f) => (rule as { kinds: string[] }).kinds.includes(f.kind)).map((f) => ({ key: f.kind, at: f.detected_at, summary: f.detail, count: 1, events: 0, simulated: f.source === "simulator" })) };
    }
    const LIMIT = 50_000;
    const rows = await sql.query<EventRow>(`select * from events where occurred_at >= now() - ($1 || ' days')::interval order by occurred_at, id limit ${LIMIT + 1}`, [String(d.days)]);
    const truncated = rows.length > LIMIT;
    const hits = await backtest(rule, rows.slice(0, LIMIT).map(toNorm), durationMs(rule.dedup_window));
    return {
      issues: [],
      evaluated: Math.min(rows.length, LIMIT),
      truncated,
      hits: hits.slice(-200).map((h) => ({ key: h.key, at: h.at, summary: h.summary, count: h.count, events: h.events.length, simulated: h.events[0]?.simulated ?? false })),
    };
  });
}

// ---------------------------------------------------------------------------
// Settings (admin)
// ---------------------------------------------------------------------------

export async function saveSettingsAction(input: unknown) {
  return action(
    {
      role: "admin",
      schema: z.object({ retention_days: z.number().int().min(7).max(3650), notify_min_severity: z.enum(["low", "medium", "high", "critical"]), notify_simulated: z.boolean() }).strict(),
    },
    input,
    async ({ sql, user }, d) => {
      for (const [k, v] of Object.entries(d)) {
        await sql.query("insert into settings (key, value, updated_by, updated_at) values ($1, $2, $3, now()) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()", [
          k,
          JSON.stringify(v),
          user.id,
        ]);
      }
      await audit(sql, user, "settings.changed", { type: "settings", id: null }, d);
      revalidatePath("/settings");
      return undefined;
    },
  );
}

export async function testChannelAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ channel: z.enum(["email", "slack", "webhook"]) }).strict() }, input, async ({ sql, user }, d) => {
    const ch = channels().find((c) => c.key === d.channel)!;
    if (!ch.configured) throw new ActionError(`${ch.label} is not configured. Set ${ch.env.join(", ")} on the server.`);
    try {
      await deliver(d.channel as ChannelKey, {
        subject: "[VIGIL] Test notification",
        text: "This is a test from VIGIL Settings. High-severity alerts will arrive here.",
        alert: { id: randomUUID(), rule_id: "TEST", title: "Test notification", severity: "low", summary: "Test", first_seen_at: new Date().toISOString(), simulated: true, incident_id: null },
      });
      await sql.query("insert into notifications (channel, status, detail) values ($1, 'sent', 'test')", [d.channel]);
      await audit(sql, user, "notification.test", { type: "channel", id: d.channel }, { ok: true });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sql.query("insert into notifications (channel, status, detail) values ($1, 'failed', $2)", [d.channel, `test: ${message}`]);
      throw new ActionError(`Test failed: ${message}`);
    }
  });
}

export async function testConnectorAction(input: unknown) {
  return action({ role: "admin", schema: z.object({}).strict() }, input, async ({ sql, user }) => {
    const r = await withWorkerLock(() => pollNexora(sql, new Date(), { force: true, maxPages: 1 }));
    await audit(sql, user, "connector.tested", { type: "connector", id: "nexora" }, { ran: r.ran, stored: r.stored, error: r.error });
    revalidatePath("/settings");
    revalidatePath("/");
    if (!r.ran) throw new ActionError("The connector is not configured: set NEXORA_URL and NEXORA_SECURITY_API_KEY on the server.");
    return { stored: r.stored, error: r.error };
  });
}

export async function runScenarioAction(input: unknown) {
  const keys = SCENARIOS.map((s) => s.key) as [string, ...string[]];
  return action({ role: "admin", schema: z.object({ key: z.enum(keys) }).strict() }, input, async ({ sql, user }, d) => {
    if (!getConfig().simulator) throw new ActionError("The simulator is off (production mode or VIGIL_SIMULATOR=0).");
    const startedAt = (await sql.query<{ now: string }>("select now()::text as now"))[0]!.now;
    const result = await withWorkerLock(() => runScenario(sql, d.key as (typeof SCENARIOS)[number]["key"], new Date()));
    // Evaluate right away so the analyst sees the alert without waiting for the next tick.
    await workerTick(sql, new Date());
    // Count every alert raised or re-fired since the run started, whichever worker evaluated it.
    const alerts = (await sql.query<{ created: number; updated: number }>(
      "select count(*) filter (where created_at >= $1)::int as created, count(*) filter (where created_at < $1 and last_seen_at >= $1)::int as updated from alerts where last_seen_at >= $1 or created_at >= $1",
      [startedAt],
    ))[0]!;
    await audit(sql, user, "simulator.scenario_run", { type: "scenario", id: d.key }, { stored: result.stored, alerts: alerts.created });
    revalidatePath("/", "layout");
    return { stored: result.stored, alerts: alerts.created, updated: alerts.updated };
  });
}

export async function runArchiveAction(input: unknown) {
  return action({ role: "admin", schema: z.object({}).strict() }, input, async ({ sql, user }) => {
    const r = await archiveOldEvents(sql, new Date(), { force: true });
    await audit(sql, user, "retention.run", { type: "events", id: null }, r);
    revalidatePath("/settings");
    return r;
  });
}

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------

export async function createUserAction(input: unknown) {
  return action(
    {
      role: "admin",
      schema: z
        .object({ email: z.email().max(254), name: z.string().trim().min(1).max(120), role: z.enum(["analyst", "admin"]), password: z.string().min(12, "At least 12 characters").max(200) })
        .strict(),
    },
    input,
    async ({ sql, user }, d) => {
      const email = d.email.toLowerCase();
      const exists = await sql.query("select 1 from users where email = $1", [email]);
      if (exists.length) throw new ActionError("A user with this email exists.");
      const id = randomUUID();
      // The initial password is shared out of band, so the new user must replace it at first sign-in.
      await sql.query("insert into users (id, email, name, role, password_hash, must_change_password) values ($1, $2, $3, $4, $5, true)", [id, email, d.name, d.role, await hashPassword(d.password)]);
      await audit(sql, user, "user.created", { type: "user", id }, { email, role: d.role });
      revalidatePath("/settings");
      return { id };
    },
  );
}

export async function updateUserAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ id: z.uuid(), role: z.enum(["analyst", "admin"]), active: z.boolean() }).strict() }, input, async ({ sql, user }, d) => {
    if (d.id === user.id && (!d.active || d.role !== "admin")) throw new ActionError("You cannot demote or deactivate yourself.");
    const before = (await sql.query<{ role: string; active: boolean }>("select role, active from users where id = $1", [d.id]))[0];
    if (!before) throw new ActionError("User not found.");
    if (before.role === "admin" && (d.role !== "admin" || !d.active)) {
      const admins = (await sql.query<{ n: number }>("select count(*)::int as n from users where role = 'admin' and active and id <> $1", [d.id]))[0]!.n;
      if (admins === 0) throw new ActionError("VIGIL needs at least one active admin.");
    }
    await sql.query("update users set role = $2, active = $3 where id = $1", [d.id, d.role, d.active]);
    if (!d.active) await sql.query("delete from sessions where user_id = $1", [d.id]);
    await audit(sql, user, "user.updated", { type: "user", id: d.id }, { from: before, to: { role: d.role, active: d.active } });
    revalidatePath("/settings");
    return undefined;
  });
}

/** Sets a temporary password; the user must change it at next sign-in, and their sessions end. */
export async function resetUserPasswordAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ id: z.uuid(), password: z.string().min(12, "At least 12 characters").max(200) }).strict() }, input, async ({ sql, user }, d) => {
    if (d.id === user.id) throw new ActionError("Change your own password from your account page.");
    const target = (await sql.query<{ email: string }>("select email from users where id = $1", [d.id]))[0];
    if (!target) throw new ActionError("User not found.");
    await sql.query("update users set password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = null where id = $1", [d.id, await hashPassword(d.password)]);
    await sql.query("delete from sessions where user_id = $1", [d.id]);
    await audit(sql, user, "user.password_reset", { type: "user", id: d.id }, { email: target.email });
    revalidatePath("/settings");
    return undefined;
  });
}

/**
 * Deletes a user account. Their past actions keep pointing at the id in the audit log and timelines
 * (shown as "deleted user"). You cannot delete yourself or the last active admin.
 */
export async function deleteUserAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ id: z.uuid() }).strict() }, input, async ({ sql, user }, d) => {
    if (d.id === user.id) throw new ActionError("You cannot delete your own account.");
    const target = (await sql.query<{ email: string; role: string; active: boolean }>("select email, role, active from users where id = $1", [d.id]))[0];
    if (!target) throw new ActionError("User not found.");
    if (target.role === "admin" && target.active) {
      const admins = (await sql.query<{ n: number }>("select count(*)::int as n from users where role = 'admin' and active and id <> $1", [d.id]))[0]!.n;
      if (admins === 0) throw new ActionError("VIGIL needs at least one active admin.");
    }
    await sql.tx(async (q) => {
      await q.query("delete from sessions where user_id = $1", [d.id]);
      await q.query("update incidents set assignee_id = null where assignee_id = $1", [d.id]);
      await q.query("delete from users where id = $1", [d.id]);
    });
    await audit(sql, user, "user.deleted", { type: "user", id: d.id }, { email: target.email, role: target.role });
    revalidatePath("/settings");
    return undefined;
  });
}
