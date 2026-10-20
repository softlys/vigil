import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageTitle, Panel, SeverityBadge } from "@/components/vigil/bits";
import { formatRule } from "@/detection/schema";
import { formatDate } from "@/lib/format";
import { getRule, ruleVersions } from "@/lib/rules-store";
import { db } from "@/server/db";
import { requireUser } from "@/server/session";
import { RuleEditor } from "./rule-editor";

export const metadata = { title: "Rule" };

export default async function RulePage({ params }: PageProps<"/rules/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[A-Z]{2,5}-\d{3}$/.test(id)) notFound();
  const sql = await db();
  const rule = await getRule(sql, id);
  if (!rule) notFound();
  const versions = await ruleVersions(sql, id);
  const users = new Map((await sql.query<{ id: string; name: string }>("select id, name from users")).map((u) => [u.id, u.name]));
  const r = rule.definition;

  return (
    <>
      <Link href="/rules" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Rules
      </Link>
      <PageTitle
        title={`${r.id} ${r.title}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={r.severity} /> {r.type} rule · version {rule.version} · {rule.enabled ? "enabled" : "disabled"}
          </span>
        }
      />
      <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-4 xl:col-span-2">
          <RuleEditor id={r.id} initial={formatRule(r)} canEdit={user.role === "admin"} />
        </div>
        <div className="space-y-4">
          <Panel title="What it detects">
            <p className="text-sm">{r.description}</p>
            {r.mitre.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {r.mitre.map((m) => (
                  <li key={m.id}>
                    <a className="font-mono text-xs text-brand hover:underline" href={`https://attack.mitre.org/techniques/${m.id.replace(".", "/")}/`} target="_blank" rel="noopener noreferrer">
                      {m.id}
                    </a>{" "}
                    {m.name} <span className="text-xs text-text-muted">({m.tactic})</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Known false positives">
            {r.false_positives.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {r.false_positives.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">None documented.</p>
            )}
            {r.tuning && <p className="mt-3 text-xs text-text-muted">Tuning: {r.tuning}</p>}
          </Panel>
          <Panel title="Versions">
            <ol className="space-y-1.5 text-sm">
              {versions.map((v) => (
                <li key={v.version} className="flex justify-between gap-2">
                  <span>v{v.version}</span>
                  <span className="text-xs text-text-muted">
                    {v.changed_by ? users.get(v.changed_by) ?? "unknown" : "built-in"} · {formatDate(v.changed_at)}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </>
  );
}
