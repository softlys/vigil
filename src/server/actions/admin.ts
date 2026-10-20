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

export async function setRuleEnabledAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ id: z.string().max(20), enabled: z.boolean() }).strict() }, input, async ({ sql, user }, d) => {
    const rule = await setRuleEnabled(sql, d.id, d.enabled, user.id);
    await audit(sql, user, d.enabled ? "rule.enabled" : "rule.disabled", { type: "rule", id: d.id }, { version: rule.version });
    revalidatePath("/rules");
    revalidatePath(`/rules/${d.id}`);
    return undefined;
  });
}

export async function saveRuleAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ id: z.string().max(20), json: z.string().max(20_000) }).strict() }, input, async ({ sql, user }, d) => {
    let definition: unknown;
    try {
      definition = JSON.parse(d.json);
    } catch (error) {
      return { issues: [{ path: "(json)", message: error instanceof Error ? error.message : "Invalid JSON" }] };
    }
    const before = await getRule(sql, d.id);
    try {
      const saved = await saveRule(sql, d.id, definition, user.id);
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

/** Runs a rule (saved or the edited draft) over stored history without creating alerts. */
export async function backtestAction(input: unknown) {
  return action({ schema: z.object({ id: z.string().max(20), json: z.string().max(20_000).optional(), days: z.number().int().min(1).max(30) }).strict() }, input, async ({ sql }, d) => {
    const { validateRule } = await import("@/detection/schema");
    const stored = await getRule(sql, d.id);
    if (!stored) throw new ActionError("Rule not found.");
    let rule = stored.definition;
    if (d.json) {
      const parsed = validateRule(JSON.parse(d.json));
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
    const result = await withWorkerLock(() => runScenario(sql, d.key as (typeof SCENARIOS)[number]["key"], new Date()));
    // Evaluate right away so the analyst sees the alert without waiting for the next tick.
    const tick = await workerTick(sql, new Date());
    await audit(sql, user, "simulator.scenario_run", { type: "scenario", id: d.key }, { stored: result.stored });
    revalidatePath("/", "layout");
    return { stored: result.stored, alerts: tick.alertsCreated + tick.integrityAlerts };
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
      await sql.query("insert into users (id, email, name, role, password_hash) values ($1, $2, $3, $4, $5)", [id, email, d.name, d.role, await hashPassword(d.password)]);
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
