import { Empty, PageTitle, pageOf, Pagination } from "@/components/vigil/bits";
import { formatDate } from "@/lib/format";
import { db } from "@/server/db";
import { listAudit, PAGE_SIZE } from "@/server/queries";
import { requireUser } from "@/server/session";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  await requireUser();
  const page = pageOf((await searchParams).page);
  const { rows, total } = await listAudit(await db(), page);
  return (
    <>
      <PageTitle title="Audit log" description="VIGIL's own sensitive actions: sign-ins, rule changes, response decisions, user and settings changes, simulator runs and archive jobs. Append-only." />
      {rows.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">Audit log</caption>
            <thead className="border-b border-border bg-surface-subtle text-xs text-text-muted">
              <tr>
                <th scope="col" className="h-9 px-3 text-left font-medium">Time</th>
                <th scope="col" className="h-9 px-3 text-left font-medium">Actor</th>
                <th scope="col" className="h-9 px-3 text-left font-medium">Action</th>
                <th scope="col" className="hidden h-9 px-3 text-left font-medium md:table-cell">Target</th>
                <th scope="col" className="hidden h-9 px-3 text-left font-medium lg:table-cell">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border align-top last:border-0" data-testid="audit-row">
                  <td className="px-3 py-2 whitespace-nowrap text-text-subtle">{formatDate(r.at)}</td>
                  <td className="px-3 py-2">{r.actor_email ?? <span className="text-text-muted">system</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                  <td className="hidden px-3 py-2 text-xs md:table-cell">
                    {r.target_type} <span className="font-mono">{r.target_id}</span>
                  </td>
                  <td className="hidden max-w-md px-3 py-2 lg:table-cell">
                    <code className="block truncate font-mono text-[11px] text-text-muted" title={JSON.stringify(r.details)}>
                      {JSON.stringify(r.details)}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} total={total} pageSize={PAGE_SIZE} base="/audit" params={{}} />
    </>
  );
}
