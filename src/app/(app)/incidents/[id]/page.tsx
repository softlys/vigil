import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/patterns/status-badge";
import { PageTitle, Panel, SeverityBadge, ShortId, SimulatedBadge } from "@/components/vigil/bits";
import { getConfig } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { PLAYBOOKS, responseCandidates } from "@/lib/response";
import { db } from "@/server/db";
import { getIncident, listUsers } from "@/server/queries";
import { requireUser } from "@/server/session";
import { IncidentControls, NoteForm, ProposeResponse, ResponseDecision } from "./controls";

export const metadata = { title: "Incident" };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function IncidentPage({ params }: PageProps<"/incidents/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sql = await db();
  const data = await getIncident(sql, id);
  if (!data) notFound();
  const users = await listUsers(sql);
  const { incident, alerts, timeline, responses, events } = data;
  const candidates = responseCandidates(events);
  const mitre = [...new Map(alerts.flatMap((a) => a.mitre).map((m) => [m.id, m])).values()];
  const config = getConfig();

  return (
    <>
      <Link href="/incidents" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Incidents
      </Link>
      <PageTitle
        title={incident.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={incident.severity} /> <StatusBadge status={incident.status} /> <SimulatedBadge simulated={incident.simulated} /> opened {formatDate(incident.created_at)}
          </span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-4 lg:col-span-2">
          <Panel title={`Alerts (${alerts.length})`}>
            <ul className="space-y-3">
              {alerts.map((a) => (
                <li key={a.id} className="rounded-md border border-border p-3" data-testid="incident-alert">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <SeverityBadge severity={a.severity} />
                    <Link href={`/rules/${a.rule_id}`} className="font-mono text-xs hover:underline">
                      {a.rule_id}
                    </Link>
                    <span className="font-medium">{a.title}</span>
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="mt-1 text-sm text-text-subtle">{a.summary}</p>
                  <p className="mt-1 text-xs text-text-muted">
                    {a.count} hit{a.count === 1 ? "" : "s"} · first {formatDate(a.first_seen_at)} · last {formatDate(a.last_seen_at)} · {a.event_ids.length} events
                  </p>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={`Related events (${events.length})`} description="Events that triggered the alerts. Click to inspect, or pivot from the event page.">
            <div className="relative max-h-96 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface text-text-muted">
                  <tr>
                    <th scope="col" className="py-1.5 pr-3 text-left font-medium">Time (UTC)</th>
                    <th scope="col" className="py-1.5 pr-3 text-left font-medium">Action</th>
                    <th scope="col" className="py-1.5 pr-3 text-left font-medium">Actor</th>
                    <th scope="col" className="py-1.5 pr-3 text-left font-medium">IP</th>
                    <th scope="col" className="py-1.5 text-left font-medium">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} className="border-t border-border" data-testid="related-event">
                      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">
                        <Link href={`/events/${e.id}`} className="hover:underline">
                          {e.occurred_at.slice(5, 19).replace("T", " ")}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-3 font-mono">{e.action}</td>
                      <td className="py-1.5 pr-3">
                        {e.actor_id ? (
                          <Link href={`/events?range=30d&actor=${encodeURIComponent(e.actor_id)}`} className="hover:underline">
                            <ShortId value={e.actor_id} />
                          </Link>
                        ) : (
                          e.actor_type
                        )}
                      </td>
                      <td className="py-1.5 pr-3 font-mono">
                        {e.source_ip ? (
                          <Link href={`/events?range=30d&ip=${encodeURIComponent(e.source_ip)}`} className="hover:underline">
                            {e.source_ip}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-1.5">
                        <ShortId value={e.target_id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Timeline">
            <ol className="space-y-2">
              {timeline.map((t) => (
                <li key={t.id} className="flex gap-3 text-sm" data-testid="timeline-entry">
                  <span className="w-36 shrink-0 text-xs text-text-muted tabular-nums">{formatDate(t.at)}</span>
                  <div className="min-w-0">
                    <StatusBadge tone={t.kind === "response" ? "warning" : t.kind === "alert" ? "danger" : t.kind === "note" ? "info" : "neutral"} label={t.kind} />{" "}
                    <span className="break-words whitespace-pre-wrap">{t.body}</span>
                    {t.actor_name && <span className="text-xs text-text-muted"> · {t.actor_name}</span>}
                    {t.kind === "response" && (t.data.request || t.data.response) ? (
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-text-muted">Request and response summary</summary>
                        <pre className="mt-1 overflow-auto rounded bg-surface-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify({ request: t.data.request, response: t.data.response }, null, 2)}</pre>
                      </details>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-4 border-t border-border pt-4">
              <NoteForm incidentId={incident.id} />
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Triage">
            <IncidentControls incidentId={incident.id} status={incident.status} assigneeId={incident.assignee_id} users={users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name }))} />
          </Panel>

          <Panel title="MITRE ATT&CK">
            {mitre.length === 0 ? (
              <p className="text-sm text-text-muted">No technique mapped.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {mitre.map((m) => (
                  <li key={m.id}>
                    <a href={`https://attack.mitre.org/techniques/${m.id.replace(".", "/")}/`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-brand hover:underline">
                      {m.id}
                    </a>{" "}
                    {m.name} <span className="text-xs text-text-muted">({m.tactic})</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Response"
            description={incident.simulated ? "Simulated incident: approved actions are recorded but never sent to NEXORA." : config.nexora.respondKey ? "Approved actions run through the NEXORA security-actions API." : "NEXORA_RESPONSE_API_KEY is not set: approved actions will fail and say why."}
          >
            <div className="space-y-3">
              {responses.length > 0 && (
                <ul className="space-y-2">
                  {responses.map((r) => (
                    <li key={r.id} className="rounded-md border border-border p-2.5 text-sm" data-testid="response-action">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{PLAYBOOKS[r.kind].label}</span>
                        <StatusBadge status={r.status} />
                        {r.simulated && <StatusBadge tone="warning" label="Simulated" />}
                      </div>
                      <p className="mt-0.5 text-xs text-text-muted">
                        Target {r.target_label ?? <ShortId value={r.target_id} />} · proposed by {r.proposed_by_name ?? "—"}
                        {r.decided_by_name ? ` · ${r.status} by ${r.decided_by_name}` : ""}
                      </p>
                      {r.reason && <p className="mt-1 text-xs">Reason: {r.reason}</p>}
                      {r.status === "proposed" && user.role === "admin" && <ResponseDecision actionId={r.id} incidentId={incident.id} label={`${PLAYBOOKS[r.kind].label} ${r.target_label ?? r.target_id}`} simulated={r.simulated} />}
                      {r.status === "proposed" && user.role !== "admin" && <p className="mt-1 text-xs text-warning">Waiting for an admin to approve or reject.</p>}
                    </li>
                  ))}
                </ul>
              )}
              <ProposeResponse incidentId={incident.id} users={candidates.users} keys={candidates.keys} />
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
