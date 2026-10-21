import Link from "next/link";
import { StatusBadge } from "@/components/patterns/status-badge";
import { cap, clampPage, Empty, first, IgnoredFilters, oneOf, PageTitle, pageOf, Pagination, RangeLinks, ShortId, SimulatedBadge } from "@/components/vigil/bits";
import { FilterBar } from "@/components/vigil/filter-bar";
import { SECURITY_CATEGORIES, SECURITY_OUTCOMES, SECURITY_SEVERITIES } from "@/domain/event-schema";
import { formatDate } from "@/lib/format";
import { db } from "@/server/db";
import { listEvents, PAGE_SIZE, rangeOf, type EventFilters } from "@/server/queries";
import { requireUser } from "@/server/session";

export const metadata = { title: "Events" };

const one = (v: string | string[] | undefined, max = 120) => {
  const s = first(v)?.trim();
  return s && s.length <= max ? s : undefined;
};

export default async function EventsPage({ searchParams }: PageProps<"/events">) {
  await requireUser();
  const p = await searchParams;
  const ignored: string[] = [];
  const f: EventFilters = {
    range: rangeOf(first(p.range)),
    action: one(p.action, 64),
    category: oneOf(p.category, SECURITY_CATEGORIES, "category", ignored),
    outcome: oneOf(p.outcome, SECURITY_OUTCOMES, "outcome", ignored),
    severity: oneOf(p.severity, SECURITY_SEVERITIES, "severity", ignored),
    actor: one(p.actor),
    ip: one(p.ip, 64),
    target: one(p.target),
    q: one(p.q, 100),
    source: oneOf(p.source, ["nexora", "simulator"], "source", ignored) as EventFilters["source"],
    page: pageOf(p.page),
  };
  const sql = await db();
  const { rows, total, facets } = await listEvents(sql, f);
  const keep = Object.fromEntries(Object.entries(f).filter(([k, v]) => k !== "page" && v !== undefined).map(([k, v]) => [k, String(v)]));
  clampPage(f.page, total, PAGE_SIZE, "/events", keep);

  return (
    <>
      <PageTitle title="Events" description="Every stored NEXORA security event, newest first. Click an event for its raw JSON and chain position; click an actor, IP or target to pivot." actions={<RangeLinks current={f.range} base="/events" params={keep} />} />
      <FilterBar
        search
        searchPlaceholder="Action, actor, IP, target, metadata…"
        pivots={["actor", "ip", "target"]}
        filters={[
          { key: "action", label: "All actions", options: facets.map((x) => ({ value: x.action, label: `${x.action} (${x.n})` })) },
          { key: "category", label: "All categories", options: SECURITY_CATEGORIES.map((c) => ({ value: c, label: cap(c) })) },
          { key: "outcome", label: "All outcomes", options: SECURITY_OUTCOMES.map((o) => ({ value: o, label: cap(o) })) },
          { key: "severity", label: "All severities", options: SECURITY_SEVERITIES.map((s) => ({ value: s, label: cap(s) })) },
          { key: "source", label: "All sources", options: [{ value: "nexora", label: "NEXORA (real)" }, { value: "simulator", label: "Simulator" }] },
        ]}
      />
      <IgnoredFilters ignored={ignored} />
      {rows.length === 0 ? (
        <Empty>No events match these filters.</Empty>
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">Events</caption>
            <thead className="border-b border-border bg-surface-subtle text-xs text-text-muted">
              <tr>
                <th scope="col" className="h-9 px-3 text-left font-medium">Time (UTC)</th>
                <th scope="col" className="h-9 px-3 text-left font-medium">Action</th>
                <th scope="col" className="h-9 px-3 text-left font-medium">Outcome</th>
                <th scope="col" className="hidden h-9 px-3 text-left font-medium md:table-cell">Actor</th>
                <th scope="col" className="hidden h-9 px-3 text-left font-medium md:table-cell">Source IP</th>
                <th scope="col" className="hidden h-9 px-3 text-left font-medium lg:table-cell">Target</th>
                <th scope="col" className="h-9 px-3 text-right font-medium">Seq</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0 hover:bg-surface-subtle" data-testid="event-row">
                  <td className="px-3 py-2 whitespace-nowrap text-text-subtle tabular-nums">
                    <Link href={`/events/${e.id}`} className="hover:underline">
                      {e.occurred_at.slice(0, 19).replace("T", " ")}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/events/${e.id}`} className="font-mono text-xs hover:underline">
                      {e.action}
                    </Link>
                    <span className="ml-2">
                      <SimulatedBadge simulated={e.simulated} />
                    </span>
                    {!e.chain_ok && <StatusBadge tone="danger" label="chain" className="ml-1" />}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={e.outcome === "failure" ? "failure" : e.outcome} label={e.outcome} />
                  </td>
                  <td className="hidden px-3 py-2 md:table-cell">
                    {e.actor_id ? (
                      <Link href={`/events?range=${f.range}&actor=${encodeURIComponent(e.actor_id)}`} className="hover:underline">
                        <span className="mr-1 text-xs text-text-muted">{e.actor_type === "api_key" ? "key" : e.actor_type}</span>
                        <ShortId value={e.actor_id} />
                      </Link>
                    ) : (
                      <span className="text-xs text-text-muted">{e.actor_type}</span>
                    )}
                  </td>
                  <td className="hidden px-3 py-2 md:table-cell">
                    {e.source_ip ? (
                      <Link href={`/events?range=${f.range}&ip=${encodeURIComponent(e.source_ip)}`} className="font-mono text-xs hover:underline">
                        {e.source_ip}
                      </Link>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className="hidden px-3 py-2 lg:table-cell">
                    {e.target_id ? (
                      <Link href={`/events?range=${f.range}&target=${encodeURIComponent(e.target_id)}`} className="hover:underline">
                        <span className="mr-1 text-xs text-text-muted">{e.target_type}</span>
                        <ShortId value={e.target_id} />
                      </Link>
                    ) : (
                      <span className="text-xs text-text-muted">{e.target_type ?? "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-text-muted tabular-nums" title={formatDate(e.ingested_at)}>
                    {e.sequence}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={f.page} total={total} pageSize={PAGE_SIZE} base="/events" params={keep} />
    </>
  );
}
