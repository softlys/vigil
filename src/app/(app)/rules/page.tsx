import Link from "next/link";
import { StatusBadge } from "@/components/patterns/status-badge";
import { PageTitle, SeverityBadge } from "@/components/vigil/bits";
import { loadRules } from "@/lib/rules-store";
import { db } from "@/server/db";
import { requireUser } from "@/server/session";
import { RuleToggle } from "./rule-toggle";

export const metadata = { title: "Rules" };

const TYPE_LABEL = { single: "Single event", threshold: "Threshold", sequence: "Sequence", new_value: "New value", integrity: "Integrity" } as const;

export default async function RulesPage() {
  const user = await requireUser();
  const sql = await db();
  const rules = await loadRules(sql);
  const stats = await sql.query<{ rule_id: string; alerts: number; last: string | null }>("select rule_id, count(*)::int as alerts, max(last_seen_at) as last from alerts where last_seen_at >= now() - interval '7 days' group by rule_id");
  const byRule = new Map(stats.map((s) => [s.rule_id, s]));
  return (
    <>
      <PageTitle
        title="Detection rules"
        description="Versioned JSON rules (inspired by Sigma). Built-in rules ship in rules/*.json; edits made here create new versions. Admins can enable, disable, edit and backtest."
      />
      <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-sm">
          <caption className="sr-only">Rules</caption>
          <thead className="border-b border-border bg-surface-subtle text-xs text-text-muted">
            <tr>
              <th scope="col" className="h-9 px-3 text-left font-medium">Rule</th>
              <th scope="col" className="hidden h-9 px-3 text-left font-medium md:table-cell">Type</th>
              <th scope="col" className="h-9 px-3 text-left font-medium">Severity</th>
              <th scope="col" className="hidden h-9 px-3 text-left font-medium lg:table-cell">ATT&CK</th>
              <th scope="col" className="hidden h-9 px-3 text-right font-medium sm:table-cell">Alerts (7d)</th>
              <th scope="col" className="h-9 px-3 text-left font-medium">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0" data-testid="rule-row">
                <td className="px-3 py-2">
                  <Link href={`/rules/${r.id}`} className="font-medium hover:underline">
                    <span className="mr-1.5 font-mono text-xs text-text-muted">{r.id}</span>
                    {r.definition.title}
                  </Link>
                  <span className="ml-2 text-xs text-text-muted">v{r.version}</span>
                </td>
                <td className="hidden px-3 py-2 text-text-subtle md:table-cell">{TYPE_LABEL[r.definition.type]}</td>
                <td className="px-3 py-2">
                  <SeverityBadge severity={r.definition.severity} />
                </td>
                <td className="hidden px-3 py-2 lg:table-cell">
                  <span className="font-mono text-xs">{r.definition.mitre.map((m) => m.id).join(", ") || "—"}</span>
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{byRule.get(r.id)?.alerts ?? 0}</td>
                <td className="px-3 py-2">{user.role === "admin" ? <RuleToggle id={r.id} enabled={r.enabled} /> : <StatusBadge status={r.enabled ? "active" : "inactive"} label={r.enabled ? "On" : "Off"} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
