import { Activity, Link2, ShieldAlert, Siren, Timer, XOctagon } from "lucide-react";
import Link from "next/link";
import { KpiCard } from "@/components/patterns/kpi-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Empty, first, PageTitle, Panel, RangeLinks, ShortId } from "@/components/vigil/bits";
import { EventsChart } from "@/components/vigil/events-chart";
import { ActivityHeatmap, ComponentGrid, IncidentList, minutes, PostureCard, SeverityPills, type Component } from "@/components/vigil/soc";
import { channels } from "@/lib/notify";
import { postureScore } from "@/lib/posture";
import { connectorConfigured, getConfig } from "@/lib/config";
import { formatNumber, formatRelative } from "@/lib/format";
import { db } from "@/server/db";
import { overview, rangeOf } from "@/server/queries";
import { requireUser } from "@/server/session";

export const metadata = { title: "Overview" };

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

function age(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function Bars({ rows, href }: { rows: Array<{ label: React.ReactNode; value: number; sub?: string; key: string }>; href?: (key: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="text-sm text-text-muted">Nothing in this range.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const body = (
          <>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="shrink-0 text-text-muted tabular-nums">
                {r.value}
                {r.sub ? ` · ${r.sub}` : ""}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-surface-muted">
              <div className="h-1.5 rounded-full bg-brand" style={{ width: `${(r.value / max) * 100}%` }} />
            </div>
          </>
        );
        return <li key={r.key}>{href ? <Link href={href(r.key)} className="block rounded hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">{body}</Link> : body}</li>;
      })}
    </ul>
  );
}

export default async function OverviewPage({ searchParams }: PageProps<"/">) {
  await requireUser();
  const params = await searchParams;
  const range = rangeOf(first(params.range));
  const sql = await db();
  const o = await overview(sql, range);
  const config = getConfig();
  const sev = Object.fromEntries(o.openBySeverity.map((s) => [s.severity, s.n])) as Record<string, number>;
  const openAlerts = Object.values(sev).reduce((a, b) => a + b, 0);
  const openIncidents = o.incidents.filter((i) => !["resolved", "false_positive"].includes(i.status)).reduce((a, b) => a + b.n, 0);
  const integrityProblems = o.status.sources.reduce((n, s) => n + s.findings.reduce((m, f) => m + f.n, 0), 0);

  const incidentSev = Object.fromEntries(o.openIncidentsBySeverity.map((s) => [s.severity, s.n])) as Record<string, number>;
  const connector = o.status.connector;
  const connectorFailing = connectorConfigured(config) && Boolean(connector.stopped_reason || (connector.last_error && connector.consecutive_failures > 0));
  const posture = postureScore({ openIncidents: incidentSev, integrityFindings24h: o.integrity24h, rulesDisabled: o.rules.total - o.rules.enabled, connectorFailing });
  const workerAge = o.status.worker ? Math.round((Date.parse(o.now) - Date.parse(o.status.worker.updated_at)) / 1000) : null;
  const configuredChannels = channels().filter((c) => c.configured).length;
  const components: Component[] = [
    {
      key: "connector",
      name: "NEXORA connector",
      detail: !connectorConfigured(config) ? "Set NEXORA_URL and a read key" : connector.last_success_at ? `Last poll ${formatRelative(connector.last_success_at)}` : "Waiting for the first poll",
      state: !connectorConfigured(config) ? "off" : connectorFailing ? "fail" : "ok",
      href: "/settings",
    },
    { key: "worker", name: "Worker", detail: workerAge === null ? "Not started yet" : `Last run ${age(workerAge)}`, state: workerAge === null ? "warn" : workerAge > 120 ? "fail" : "ok" },
    { key: "rules", name: "Detection rules", detail: `${o.rules.enabled} of ${o.rules.total} enabled`, state: o.rules.enabled === o.rules.total ? "ok" : "warn", href: "/rules" },
    { key: "integrity", name: "Integrity checks", detail: o.integrity24h ? `${o.integrity24h} finding${o.integrity24h === 1 ? "" : "s"} in 24 h` : "Chain, gaps, heartbeat", state: o.integrity24h ? "fail" : "ok", href: "/alerts?rule=VGL-015" },
    { key: "notifications", name: "Notifications", detail: configuredChannels ? `${configuredChannels} channel${configuredChannels === 1 ? "" : "s"} configured` : "Email, Slack or webhook", state: configuredChannels ? "ok" : "off", href: "/settings" },
    { key: "response", name: "Response", detail: config.nexora.respondKey ? "2 playbooks · approval required" : "Respond key not set", state: config.nexora.respondKey ? "ok" : "off" },
    ...(config.simulator ? [{ key: "simulator", name: "Simulator", detail: "Demo traffic and attacks", state: "warn" as const, href: "/settings" }] : []),
  ];

  return (
    <>
      <PageTitle
        title="Security Operations Center"
        description="Computed from the stored events, alerts and incidents. Simulated and real NEXORA events are both counted; filter by source in Events."
        actions={
          <>
            <SeverityPills counts={sev} />
            <RangeLinks current={range} base="/" params={{}} />
          </>
        }
      />

      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label={`Events (${range})`} icon={Activity} tone="info" spark={o.series.map((p) => p.total)} value={formatNumber(o.totals.events)} hint={`${o.totals.per_minute} per minute`} href={`/events?range=${range}`} />
        <KpiCard label="Failures" icon={XOctagon} tone="danger" spark={o.series.map((p) => p.failures)} value={formatNumber(o.totals.failures)} hint="Outcome failure" href={`/events?range=${range}&outcome=failure`} />
        <KpiCard label="Open alerts" icon={ShieldAlert} tone="warning" value={formatNumber(openAlerts)} hint={`${sev.critical ?? 0} critical · ${sev.high ?? 0} high`} href="/alerts?status=open" />
        <KpiCard label="Open incidents" icon={Siren} tone="brand" value={formatNumber(openIncidents)} hint="New, triaged or investigating" href="/incidents?status=open" />
        <KpiCard label="Integrity findings" icon={Link2} tone={integrityProblems ? "danger" : "success"} value={formatNumber(integrityProblems)} hint="Chain, gaps, heartbeat, schema" href="/alerts?rule=VGL-015" />
      </section>

      <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <Panel title="Activity heatmap" description="Events per hour over the last 7 days (UTC). Darker means more events." className="xl:col-span-2">
          <ActivityHeatmap cells={o.heatmap} now={new Date(o.now)} />
        </Panel>
        <Panel title="Priority incidents" description="Open, most severe first" actions={<Link href="/incidents?status=open" className="text-xs text-brand hover:underline">All incidents</Link>}>
          <IncidentList rows={o.recentIncidents} />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <Panel title="Security posture" description="An explainable score, not a model">
          <PostureCard posture={posture} />
        </Panel>
        <Panel title="Monitoring components" description="What VIGIL relies on, and whether it is working" className="xl:col-span-2">
          <ComponentGrid items={components} />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <div className="xl:col-span-2">
          <EventsChart data={o.series} bucketMinutes={o.bucketMinutes} />
        </div>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
              <p className="flex items-center justify-between text-sm text-text-subtle">
                Time to detect <Timer className="size-4 text-info" aria-hidden />
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{minutes(o.timing.mttd)}</p>
              <p className="text-xs text-text-muted">Median, first event to alert · {o.timing.detected} alerts</p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
              <p className="flex items-center justify-between text-sm text-text-subtle">
                Time to resolve <Timer className="size-4 text-brand" aria-hidden />
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{minutes(o.timing.mttr)}</p>
              <p className="text-xs text-text-muted">Median, opened to resolved · {o.timing.resolved} incidents</p>
            </div>
          </div>
          <Panel title="Open alerts by severity">
            <Bars rows={SEVERITIES.map((s) => ({ key: s, label: <StatusBadge status={s} dot />, value: sev[s] ?? 0 }))} href={(s) => `/alerts?status=open&severity=${s}`} />
          </Panel>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <Panel title="Top rules fired" description={`Alerts with activity in the last ${range}`}>
          <Bars rows={o.topRules.map((r) => ({ key: r.rule_id, label: `${r.rule_id} ${r.title}`, value: r.n, sub: `${r.hits} hits` }))} href={(k) => `/alerts?rule=${k}`} />
        </Panel>
        <Panel title="Top source IPs" description="Ranked by failures, then volume">
          <Bars rows={o.topIps.map((r) => ({ key: r.value, label: <span className="font-mono">{r.value}</span>, value: r.n, sub: `${r.failures} failed` }))} href={(k) => `/events?range=${range}&ip=${encodeURIComponent(k)}`} />
        </Panel>
        <Panel title="Top actors" description="Users and API keys, ranked by failures">
          <Bars rows={o.topActors.map((r) => ({ key: r.value, label: <span className="flex items-center gap-1.5"><span className="text-text-muted">{r.type === "api_key" ? "key" : r.type}</span><ShortId value={r.value} /></span>, value: r.n, sub: `${r.failures} failed` }))} href={(k) => `/events?range=${range}&actor=${encodeURIComponent(k)}`} />
        </Panel>
      </div>

      <Panel title="Sources, connector and integrity" description="Every source is verified on ingest: sequence continuity, prev_hash links and content hashes, plus a heartbeat at least every 15 minutes.">
        {o.status.sources.length === 0 ? (
          <Empty>No events ingested yet. The worker runs every 10 seconds.</Empty>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Sources</caption>
              <thead className="border-b border-border text-xs text-text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-3 text-left font-medium">Source</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Events</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Last sequence</th>
                  <th scope="col" className="py-2 pr-3 text-left font-medium">Last event</th>
                  <th scope="col" className="py-2 pr-3 text-left font-medium">Heartbeat</th>
                  <th scope="col" className="py-2 text-left font-medium">Integrity</th>
                </tr>
              </thead>
              <tbody>
                {o.status.sources.map((s) => {
                  const hbOk = s.heartbeat_age_seconds !== null && s.heartbeat_age_seconds <= 15 * 60;
                  const kinds = s.findings.map((f) => `${f.n} ${f.kind.replace("_", " ")}`).join(", ");
                  return (
                    <tr key={`${s.source}-${s.organization_id}`} className="border-b border-border last:border-0" data-testid={`source-${s.source}`}>
                      <td className="py-2 pr-3">
                        {s.source === "simulator" ? <StatusBadge tone="warning" label="Simulator" /> : <StatusBadge tone="info" label="NEXORA" />}
                        <ShortId value={s.organization_id} className="ml-2 text-text-muted" />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(s.events_ingested)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{s.last_sequence}</td>
                      <td className="py-2 pr-3 text-text-subtle">{age(s.lag_seconds)}</td>
                      <td className="py-2 pr-3">
                        <StatusBadge tone={hbOk ? "success" : "danger"} label={age(s.heartbeat_age_seconds)} dot />
                      </td>
                      <td className="py-2">{s.findings.length ? <StatusBadge tone="danger" label={kinds} /> : <StatusBadge tone="success" label="Chain intact" dot />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 grid gap-3 border-t border-border pt-4 text-xs text-text-muted sm:grid-cols-2">
          <p>
            <span className="font-medium text-foreground">NEXORA connector: </span>
            {!connectorConfigured(config) ? (
              <>Not configured. Set NEXORA_URL and NEXORA_SECURITY_API_KEY (see Settings).</>
            ) : o.status.connector.stopped_reason ? (
              <span className="text-danger">Stopped: {o.status.connector.stopped_reason}</span>
            ) : o.status.connector.last_error && o.status.connector.consecutive_failures > 0 ? (
              <span className="text-danger">
                Failing ({o.status.connector.consecutive_failures}×): {o.status.connector.last_error}
              </span>
            ) : o.status.connector.last_success_at ? (
              <>Last successful poll {formatRelative(o.status.connector.last_success_at)}.</>
            ) : (
              <>Configured, waiting for the first poll.</>
            )}
          </p>
          <p>
            <span className="font-medium text-foreground">Worker: </span>
            {o.status.worker ? `last run ${formatRelative(o.status.worker.updated_at)} (${String(o.status.worker.value.durationMs)} ms${(o.status.worker.value.errors as string[]).length ? `, ${(o.status.worker.value.errors as string[]).length} errors` : ""})` : "not started yet"}
          </p>
        </div>
      </Panel>
    </>
  );
}
