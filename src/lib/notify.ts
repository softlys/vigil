/**
 * Notifications for high-severity alerts: email (Resend), Slack incoming webhook, generic webhook
 * (HMAC-signed). Each channel is configured only through server environment variables; without
 * them it shows "Not configured" and nothing is sent. Every attempt is logged in `notifications`.
 */
import { createHmac } from "node:crypto";
import type { AlertRow } from "./alerts";
import { getSetting } from "./bootstrap";
import type { Sql } from "./db";

export type ChannelKey = "email" | "slack" | "webhook";
export type Channel = { key: ChannelKey; label: string; configured: boolean; target: string | null; env: string[] };

function host(url: string | undefined): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

export function channels(env: NodeJS.ProcessEnv = process.env): Channel[] {
  return [
    { key: "email", label: "Email (Resend)", configured: Boolean(env.RESEND_API_KEY && env.VIGIL_ALERT_EMAIL_FROM && env.VIGIL_ALERT_EMAIL_TO), target: env.VIGIL_ALERT_EMAIL_TO ?? null, env: ["RESEND_API_KEY", "VIGIL_ALERT_EMAIL_FROM", "VIGIL_ALERT_EMAIL_TO"] },
    { key: "slack", label: "Slack incoming webhook", configured: Boolean(env.VIGIL_SLACK_WEBHOOK_URL), target: host(env.VIGIL_SLACK_WEBHOOK_URL), env: ["VIGIL_SLACK_WEBHOOK_URL"] },
    { key: "webhook", label: "Generic webhook (HMAC-signed)", configured: Boolean(env.VIGIL_ALERT_WEBHOOK_URL && env.VIGIL_ALERT_WEBHOOK_SECRET), target: host(env.VIGIL_ALERT_WEBHOOK_URL), env: ["VIGIL_ALERT_WEBHOOK_URL", "VIGIL_ALERT_WEBHOOK_SECRET"] },
  ];
}

export type Message = { subject: string; text: string; alert: Pick<AlertRow, "id" | "rule_id" | "title" | "severity" | "summary" | "first_seen_at" | "simulated" | "incident_id"> };

export async function deliver(channel: ChannelKey, message: Message, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<void> {
  const signal = AbortSignal.timeout(8_000);
  if (channel === "email") {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.VIGIL_ALERT_EMAIL_FROM, to: env.VIGIL_ALERT_EMAIL_TO!.split(",").map((s) => s.trim()), subject: message.subject, text: message.text }),
      signal,
    });
    if (!res.ok) throw new Error(`Resend answered HTTP ${res.status}`);
    return;
  }
  if (channel === "slack") {
    const res = await fetchImpl(env.VIGIL_SLACK_WEBHOOK_URL!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `*${message.subject}*\n${message.text}` }), signal });
    if (!res.ok) throw new Error(`Slack answered HTTP ${res.status}`);
    return;
  }
  const body = JSON.stringify({ type: "vigil.alert", alert: message.alert });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", env.VIGIL_ALERT_WEBHOOK_SECRET!).update(`${t}.${body}`).digest("hex");
  const res = await fetchImpl(env.VIGIL_ALERT_WEBHOOK_URL!, { method: "POST", headers: { "Content-Type": "application/json", "X-Vigil-Signature": `t=${t},v1=${sig}` }, body, signal });
  if (!res.ok) throw new Error(`Webhook answered HTTP ${res.status}`);
}

const RANK = { low: 1, medium: 2, high: 3, critical: 4 } as const;

export function messageFor(a: AlertRow, baseUrl: string | null): Message {
  const link = baseUrl && a.incident_id ? `${baseUrl}/incidents/${a.incident_id}` : null;
  return {
    subject: `[VIGIL ${a.severity.toUpperCase()}]${a.simulated ? " [SIMULATED]" : ""} ${a.rule_id} ${a.title}`,
    text: [a.summary, `First seen: ${a.first_seen_at}`, link ? `Investigate: ${link}` : null].filter(Boolean).join("\n"),
    alert: { id: a.id, rule_id: a.rule_id, title: a.title, severity: a.severity, summary: a.summary, first_seen_at: a.first_seen_at, simulated: a.simulated, incident_id: a.incident_id },
  };
}

/** Sends notifications for new alerts at or above the configured severity. Each alert is handled once. */
export async function notifyNewAlerts(sql: Sql, options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<number> {
  const env = options.env ?? process.env;
  const minSeverity = await getSetting<keyof typeof RANK>(sql, "notify_min_severity");
  const includeSimulated = await getSetting<boolean>(sql, "notify_simulated");
  const pending = await sql.query<AlertRow>("select * from alerts where notified_at is null order by created_at limit 50");
  const active = channels(env).filter((c) => c.configured);
  let sent = 0;
  for (const a of pending) {
    await sql.query("update alerts set notified_at = now() where id = $1", [a.id]);
    if (RANK[a.severity] < RANK[minSeverity] || (a.simulated && !includeSimulated)) continue;
    if (active.length === 0) {
      await sql.query("insert into notifications (alert_id, channel, status, detail) values ($1, 'none', 'skipped', 'No notification channel is configured')", [a.id]);
      continue;
    }
    for (const c of active) {
      try {
        await deliver(c.key, messageFor(a, env.VIGIL_PUBLIC_URL ?? null), env, options.fetchImpl);
        await sql.query("insert into notifications (alert_id, channel, status) values ($1, $2, 'sent')", [a.id, c.key]);
        sent += 1;
      } catch (error) {
        await sql.query("insert into notifications (alert_id, channel, status, detail) values ($1, $2, 'failed', $3)", [a.id, c.key, String(error instanceof Error ? error.message : error).slice(0, 500)]);
      }
    }
  }
  return sent;
}
