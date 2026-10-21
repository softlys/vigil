import Link from "next/link";
import { StatusBadge } from "@/components/patterns/status-badge";
import { cap, clampPage, Empty, IgnoredFilters, oneOf, PageTitle, pageOf, Pagination, SeverityBadge, SimulatedBadge } from "@/components/vigil/bits";
import { FilterBar } from "@/components/vigil/filter-bar";
import { formatRelative } from "@/lib/format";
import { loadRules } from "@/lib/rules-store";
import { db } from "@/server/db";
import { listAlerts, PAGE_SIZE } from "@/server/queries";
import { requireUser } from "@/server/session";

export const metadata = { title: "Alerts" };

export default async function AlertsPage({ searchParams }: PageProps<"/alerts">) {
  await requireUser();
  const p = await searchParams;
  const ignored: string[] = [];
  const status = oneOf(p.status, ["open", "closed"], "status", ignored);
  const severity = oneOf(p.severity, ["critical", "high", "medium", "low"], "severity", ignored);
  const sql = await db();
  const rules = await loadRules(sql);
  const rule = oneOf(p.rule, rules.map((r) => r.id), "rule", ignored);
  const page = pageOf(p.page);
  const { rows, total } = await listAlerts(sql, { status, severity, rule, page });
  const keep = { status, severity, rule };
  clampPage(page, total, PAGE_SIZE, "/alerts", keep);

  return (
    <>
      <PageTitle title="Alerts" description="One alert per rule and entity while its dedup window is open; repeated hits raise the count instead of creating new alerts. Each alert belongs to an incident." />
      <FilterBar
        filters={[
          { key: "status", label: "All statuses", options: [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }] },
          { key: "severity", label: "All severities", options: ["critical", "high", "medium", "low"].map((s) => ({ value: s, label: cap(s) })) },
          { key: "rule", label: "All rules", options: rules.map((r) => ({ value: r.id, label: `${r.id} ${r.definition.title}` })) },
        ]}
      />
      <IgnoredFilters ignored={ignored} />
      {rows.length === 0 ? (
        <Empty>No alerts match these filters.</Empty>
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">Alerts</caption>
            <thead className="border-b border-border bg-surface-subtle text-xs text-text-muted">
              <tr>
                <th scope="col" className="h-9 px-3 text-left font-medium">Alert</th>
                <th scope="col" className="h-9 px-3 text-left font-medium">Severity</th>
                <th scope="col" className="hidden h-9 px-3 text-left font-medium md:table-cell">Status</th>
                <th scope="col" className="hidden h-9 px-3 text-right font-medium sm:table-cell">Hits</th>
                <th scope="col" className="h-9 px-3 text-left font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0 hover:bg-surface-subtle" data-testid="alert-row">
                  <td className="max-w-xl px-3 py-2">
                    <Link href={a.incident_id ? `/incidents/${a.incident_id}` : "#"} className="font-medium hover:underline">
                      <span className="mr-1.5 font-mono text-xs text-text-muted">{a.rule_id}</span>
                      {a.title}
                    </Link>
                    <span className="ml-2">
                      <SimulatedBadge simulated={a.simulated} />
                    </span>
                    <p className="truncate text-xs text-text-muted">{a.summary}</p>
                  </td>
                  <td className="px-3 py-2">
                    <SeverityBadge severity={a.severity} />
                  </td>
                  <td className="hidden px-3 py-2 md:table-cell">
                    <StatusBadge status={a.status} />
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{a.count}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-text-subtle">{formatRelative(a.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} total={total} pageSize={PAGE_SIZE} base="/alerts" params={keep} />
    </>
  );
}
