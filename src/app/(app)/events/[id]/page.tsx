import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/patterns/status-badge";
import { PageTitle, Panel, SeverityBadge, ShortId, SimulatedBadge } from "@/components/vigil/bits";
import { formatDate } from "@/lib/format";
import { db } from "@/server/db";
import { getEvent } from "@/server/queries";
import type { Metadata } from "next";
import { getCurrentUser, requireUser } from "@/server/session";

export async function generateMetadata({ params }: PageProps<"/events/[id]">): Promise<Metadata> {
  const n = Number((await params).id);
  if (!(await getCurrentUser()) || !Number.isSafeInteger(n) || n < 1) return { title: "Event" };
  const data = await getEvent(await db(), n);
  return { title: data ? `${data.event.action} #${data.event.sequence}` : "Event" };
}

export default async function EventPage({ params }: PageProps<"/events/[id]">) {
  await requireUser();
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) notFound();
  const data = await getEvent(await db(), n);
  if (!data) notFound();
  const { event: e, neighbours, alerts } = data;
  const pivots = [
    e.actor_id && { label: `Everything by this ${e.actor_type === "api_key" ? "API key" : e.actor_type}`, href: `/events?range=30d&actor=${encodeURIComponent(e.actor_id)}` },
    e.source_ip && { label: `Everything from ${e.source_ip}`, href: `/events?range=30d&ip=${encodeURIComponent(e.source_ip)}` },
    e.target_id && { label: `Everything about this ${e.target_type ?? "target"}`, href: `/events?range=30d&target=${encodeURIComponent(e.target_id)}` },
    { label: `All ${e.action} events`, href: `/events?range=7d&action=${encodeURIComponent(e.action)}` },
  ].filter(Boolean) as Array<{ label: string; href: string }>;

  return (
    <>
      <Link href="/events" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Events
      </Link>
      <PageTitle
        title={e.action}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {formatDate(e.occurred_at)} · sequence {e.sequence} <SeverityBadge severity={e.severity} /> <StatusBadge status={e.outcome === "failure" ? "failure" : e.outcome} label={e.outcome} /> <SimulatedBadge simulated={e.simulated} />
          </span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-4 lg:col-span-2">
          <Panel title="Fields">
            <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-text-muted">Category</dt>
              <dd>{e.category}</dd>
              <dt className="text-text-muted">Actor</dt>
              <dd>
                {e.actor_type} <ShortId value={e.actor_id} /> {e.actor_role && <span className="text-text-muted">({e.actor_role})</span>}
              </dd>
              <dt className="text-text-muted">Source IP</dt>
              <dd className="font-mono text-xs">{e.source_ip ?? "—"}</dd>
              <dt className="text-text-muted">User agent</dt>
              <dd className="text-xs break-all">{e.user_agent ?? "—"}</dd>
              <dt className="text-text-muted">Target</dt>
              <dd>
                {e.target_type ?? "—"} <ShortId value={e.target_id} />
              </dd>
              <dt className="text-text-muted">Request id</dt>
              <dd className="font-mono text-xs break-all">{e.request_id ?? "—"}</dd>
              <dt className="text-text-muted">Event id</dt>
              <dd className="font-mono text-xs break-all">{e.event_id}</dd>
              <dt className="text-text-muted">Organization</dt>
              <dd className="font-mono text-xs break-all">{e.organization_id}</dd>
              <dt className="text-text-muted">Ingested</dt>
              <dd>
                {formatDate(e.ingested_at)} from {e.source === "simulator" ? "the simulator" : "NEXORA"}
              </dd>
            </dl>
          </Panel>
          <Panel title="Raw event" description="Exactly as received; the hash covers every field except prev_hash and hash.">
            <pre className="max-h-[28rem] overflow-auto rounded bg-surface-muted p-3 font-mono text-[11px] whitespace-pre-wrap" data-testid="raw-json">
              {JSON.stringify(e.raw, null, 2)}
            </pre>
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel title="Pivot">
            <ul className="space-y-1.5 text-sm">
              {pivots.map((pv) => (
                <li key={pv.href}>
                  <Link className="text-brand hover:underline" href={pv.href}>
                    {pv.label}
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Chain position" description={e.chain_ok ? "Verified on ingest: sequence, link and hash." : "This event failed verification on ingest."}>
            <ul className="mb-3 grid grid-cols-3 gap-1.5 text-[11px]">
              {[
                ["Sequence", e.chain_ok],
                ["Link", e.chain_ok],
                ["Hash", e.chain_ok],
              ].map(([label, ok]) => (
                <li key={String(label)} className={`flex items-center justify-between rounded-md border px-2 py-1 ${ok ? "border-success-border bg-success-bg text-success" : "border-danger-border bg-danger-bg text-danger"}`}>
                  {label} <span className="font-semibold">{ok ? "PASS" : "FAIL"}</span>
                </li>
              ))}
            </ul>
            <ol>
              {neighbours.map((nb, i) => (
                <li key={nb.id}>
                  {i > 0 && <div className={`ml-5 h-2.5 border-l-2 ${nb.chain_ok ? "border-success/60" : "border-danger/70"}`} aria-hidden />}
                  <div className={`rounded-lg border p-2.5 text-xs ${nb.id === e.id ? "border-brand bg-brand-subtle/30" : "border-border bg-surface-subtle"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="rounded-md bg-brand px-1.5 py-0.5 font-semibold text-brand-foreground tabular-nums">#{nb.sequence}</span>
                        <Link href={`/events/${nb.id}`} className="truncate font-medium hover:underline">
                          {nb.action}
                        </Link>
                      </span>
                      <span className={`text-[11px] font-semibold ${nb.chain_ok ? "text-success" : "text-danger"}`}>{nb.chain_ok ? "VALID" : "BROKEN"}</span>
                    </div>
                    <dl className="mt-1.5 grid grid-cols-2 gap-2 font-mono text-[10px]">
                      <div className="min-w-0">
                        <dt className="tracking-wider text-text-muted uppercase">Hash</dt>
                        <dd className="truncate text-info" title={nb.hash}>
                          sha256:{nb.hash.slice(0, 10)}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="tracking-wider text-text-muted uppercase">Previous</dt>
                        <dd className="truncate text-text-subtle" title={nb.prev_hash}>
                          sha256:{nb.prev_hash.slice(0, 10)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
          <Panel title="Alerts with this event">
            {alerts.length === 0 ? (
              <p className="text-sm text-text-muted">None.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {alerts.map((a) => (
                  <li key={a.id}>
                    <Link href={a.incident_id ? `/incidents/${a.incident_id}` : "/alerts"} className="hover:underline">
                      <SeverityBadge severity={a.severity} /> {a.rule_id} {a.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
