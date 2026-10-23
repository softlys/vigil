import { StatusBadge } from "@/components/patterns/status-badge";
import { PageTitle, Panel } from "@/components/vigil/bits";
import { getSetting } from "@/lib/bootstrap";
import { connectorConfigured, getConfig } from "@/lib/config";
import { connectorHealth } from "@/lib/connector";
import { formatDate, formatRelative } from "@/lib/format";
import { channels } from "@/lib/notify";
import { SCENARIOS } from "@/simulator/generator";
import { db } from "@/server/db";
import { listUsers } from "@/server/queries";
import { requireAdmin } from "@/server/session";
import { ChannelTest, ConnectorTest, NotificationSettings, RetentionSettings, ScenarioRunner, Users } from "./settings-forms";

export const metadata = { title: "Settings" };

function hostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return url;
  }
}

export default async function SettingsPage() {
  const user = await requireAdmin();
  const sql = await db();
  const config = getConfig();
  const [health, users, retention, minSeverity, notifySimulated, archive, recentNotifications] = await Promise.all([
    connectorHealth(sql),
    listUsers(sql),
    getSetting<number>(sql, "retention_days"),
    getSetting<string>(sql, "notify_min_severity"),
    getSetting<boolean>(sql, "notify_simulated"),
    sql.query<{ value: { at: string; archived: number; cutoff: string } }>("select value from worker_state where name = 'archive'"),
    sql.query<{ channel: string; status: string; detail: string | null; at: string }>("select channel, status, detail, at from notifications order by at desc limit 8"),
  ]);
  const archivedTotal = (await sql.query<{ n: number }>("select count(*)::int as n from events_archive"))[0]!.n;
  const configured = connectorConfigured(config);

  return (
    <>
      <PageTitle title="Settings" description="Admin only. Secrets (NEXORA keys, webhook secrets) are configured as server environment variables and never shown here; this page shows whether they are set." />

      <Panel title="NEXORA connector" description="Polls GET /api/v1/security-events with a SIEM key that has security:read. Response actions use a separate key with security:respond.">
        <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-text-muted">Status</dt>
          <dd>
            {!configured ? (
              <StatusBadge status="not_configured" label="Not configured" dot />
            ) : health.stopped_reason ? (
              <StatusBadge status="error" label="Stopped" dot />
            ) : health.consecutive_failures > 0 ? (
              <StatusBadge status="error" label={`Failing (${health.consecutive_failures}×)`} dot />
            ) : health.last_success_at ? (
              <StatusBadge status="connected" label="Connected" dot />
            ) : (
              <StatusBadge status="configured" label="Configured (not polled yet)" dot />
            )}
          </dd>
          <dt className="text-text-muted">NEXORA_URL</dt>
          <dd className="font-mono text-xs">{hostOf(config.nexora.url) ?? "not set"}</dd>
          <dt className="text-text-muted">Read key (security:read)</dt>
          <dd>{config.nexora.readKey ? "set" : "not set"}</dd>
          <dt className="text-text-muted">Respond key (security:respond)</dt>
          <dd>{config.nexora.respondKey ? "set" : "not set"}</dd>
          <dt className="text-text-muted">Poll interval</dt>
          <dd>
            {config.nexora.pollSeconds} s, {config.nexora.pageSize} events per page
          </dd>
          <dt className="text-text-muted">Last successful poll</dt>
          <dd>{health.last_success_at ? `${formatRelative(health.last_success_at)} (${health.last_batch} new events)` : "never"}</dd>
          {health.last_error && (
            <>
              <dt className="text-text-muted">Last error</dt>
              <dd className="text-danger">
                {health.last_error} {health.last_error_at && <span className="text-text-muted">({formatRelative(health.last_error_at)})</span>}
              </dd>
            </>
          )}
          {health.stopped_reason && (
            <>
              <dt className="text-text-muted">Stopped</dt>
              <dd className="text-danger">{health.stopped_reason}</dd>
            </>
          )}
          <dt className="text-text-muted">Push receiver</dt>
          <dd>{config.ingestSecret ? "POST /api/ingest/nexora is enabled (HMAC-signed)" : "Disabled: set VIGIL_INGEST_SECRET to enable POST /api/ingest/nexora"}</dd>
        </dl>
        <div className="mt-4">
          <ConnectorTest disabled={!configured} />
        </div>
      </Panel>

      {config.simulator && (
        <Panel title="Simulator" description="Runs one scripted attack now, as NEXORA-format events with a valid hash chain. Results are labelled Simulated. Privilege escalation also fires VGL-005 only outside working hours (07–20 UTC, Monday–Friday).">
          <ScenarioRunner scenarios={SCENARIOS.map((s) => ({ key: s.key, title: s.title, rules: [...s.rules] }))} />
        </Panel>
      )}

      <Panel title="Notifications" description="High-severity alerts can be sent by email, Slack or a signed webhook. A channel is active only when its environment variables are set.">
        <div className="space-y-3">
          {channels().map((c) => (
            <div key={c.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3" data-testid={`channel-${c.key}`}>
              <div>
                <p className="text-sm font-medium">{c.label}</p>
                <p className="text-xs text-text-muted">{c.configured ? `Target: ${c.target}` : `Set ${c.env.join(", ")}`}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={c.configured ? "configured" : "not_configured"} label={c.configured ? "Configured" : "Not configured"} dot />
                {c.configured && <ChannelTest channel={c.key} />}
              </div>
            </div>
          ))}
          <NotificationSettings minSeverity={minSeverity} notifySimulated={notifySimulated} retentionDays={retention} />
          {recentNotifications.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-text-muted">Recent notification attempts</summary>
              <ul className="mt-2 space-y-1">
                {recentNotifications.map((n, i) => (
                  <li key={i}>
                    {formatDate(n.at)} · {n.channel} · {n.status}
                    {n.detail ? ` · ${n.detail}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Panel>

      <Panel title="Retention" description="Events older than the retention period move to the archive table once a day. The events table accepts no updates and no deletes outside this job.">
        <RetentionSettings retentionDays={retention} minSeverity={minSeverity} notifySimulated={notifySimulated} />
        <p className="mt-3 text-xs text-text-muted">
          Archived events: {archivedTotal}. {archive[0] ? `Last run ${formatRelative(archive[0].value.at)}, moved ${archive[0].value.archived} (cutoff ${formatDate(archive[0].value.cutoff)}).` : "Not run yet."}
        </p>
      </Panel>

      <Panel title="Users and roles" description="Analysts investigate and propose responses; admins also approve responses, edit rules and manage settings and users. Two-factor sign-in (authenticator app) is required in production mode; deployments should also sit behind SSO.">
        <Users users={users} currentUserId={user.id} />
      </Panel>
    </>
  );
}
