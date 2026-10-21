import Link from "next/link";
import { StatusBadge } from "@/components/patterns/status-badge";
import { cap, clampPage, Empty, IgnoredFilters, oneOf, PageTitle, pageOf, Pagination, SeverityBadge, SimulatedBadge } from "@/components/vigil/bits";
import { FilterBar } from "@/components/vigil/filter-bar";
import { formatRelative } from "@/lib/format";
import { db } from "@/server/db";
import { listIncidents, listUsers, PAGE_SIZE } from "@/server/queries";
import { requireUser } from "@/server/session";

export const metadata = { title: "Incidents" };

const STATUSES = ["open", "new", "triaged", "investigating", "resolved", "false_positive"];

export default async function IncidentsPage({ searchParams }: PageProps<"/incidents">) {
  await requireUser();
  const p = await searchParams;
  const ignored: string[] = [];
  const status = oneOf(p.status, STATUSES, "status", ignored);
  const severity = oneOf(p.severity, ["critical", "high", "medium", "low"], "severity", ignored);
  const page = pageOf(p.page);
  const sql = await db();
  const users = await listUsers(sql);
  const assignee = oneOf(p.assignee, ["none", ...users.map((u) => u.id)], "assignee", ignored);
  const { rows, total } = await listIncidents(sql, { status, severity, assignee, page });
  const keep = { status, severity, assignee };
  clampPage(page, total, PAGE_SIZE, "/incidents", keep);

  return (
    <>
      <PageTitle title="Incidents" description="Related alerts about the same entity (account, IP, actor, key) within 24 hours are grouped into one incident. Work them from new to resolved or false positive." />
      <FilterBar
        filters={[
          { key: "status", label: "All statuses", options: STATUSES.map((s) => ({ value: s, label: s === "open" ? "Open (not closed)" : cap(s) })) },
          { key: "severity", label: "All severities", options: ["critical", "high", "medium", "low"].map((s) => ({ value: s, label: cap(s) })) },
          { key: "assignee", label: "Anyone", options: [{ value: "none", label: "Unassigned" }, ...users.map((u) => ({ value: u.id, label: u.name }))] },
        ]}
      />
      <IgnoredFilters ignored={ignored} />
      {rows.length === 0 ? (
        <Empty>No incidents match these filters.</Empty>
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">Incidents</caption>
            <thead className="border-b border-border bg-surface-subtle text-xs text-text-muted">
              <tr>
                <th scope="col" className="h-9 px-3 text-left font-medium">Incident</th>
                <th scope="col" className="h-9 px-3 text-left font-medium">Severity</th>
                <th scope="col" className="h-9 px-3 text-left font-medium">Status</th>
                <th scope="col" className="hidden h-9 px-3 text-right font-medium sm:table-cell">Alerts</th>
                <th scope="col" className="hidden h-9 px-3 text-left font-medium md:table-cell">Assignee</th>
                <th scope="col" className="h-9 px-3 text-left font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="border-b border-border last:border-0 hover:bg-surface-subtle" data-testid="incident-row">
                  <td className="px-3 py-2">
                    <Link href={`/incidents/${i.id}`} className="font-medium hover:underline">
                      {i.title}
                    </Link>
                    <span className="ml-2">
                      <SimulatedBadge simulated={i.simulated} />
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <SeverityBadge severity={i.severity} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={i.status} />
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{i.alert_count}</td>
                  <td className="hidden px-3 py-2 text-text-subtle md:table-cell">{i.assignee_name ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-text-subtle">{formatRelative(i.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} total={total} pageSize={PAGE_SIZE} base="/incidents" params={keep} />
    </>
  );
}
