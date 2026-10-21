"use client";

import { FlaskConical, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Panel } from "@/components/vigil/bits";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { backtestAction, saveRuleAction } from "@/server/actions/admin";

type Issue = { path: string; message: string };
type BacktestHit = { key: string; at: string; summary: string; count: number; events: number; simulated: boolean };

export function RuleEditor({ id, initial, canEdit }: { id: string; initial: string; canEdit: boolean }) {
  const router = useRouter();
  const [json, setJson] = useState(initial);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [days, setDays] = useState("7");
  const [result, setResult] = useState<{ hits: BacktestHit[]; evaluated: number; truncated: boolean } | null>(null);
  const [pending, start] = useTransition();
  const dirty = json !== initial;

  const edit = (value: string) => {
    setJson(value);
    // Old problems and old backtest results describe a different draft.
    if (issues.length) setIssues([]);
    if (result) setResult(null);
  };

  const save = () =>
    start(async () => {
      setResult(null);
      const r = await saveRuleAction({ id, json });
      if (!r.ok) return void toast.error(r.error);
      if ("issues" in r.data && r.data.issues) return setIssues(r.data.issues);
      setIssues([]);
      toast.success(`Saved as version ${r.data.version}`);
      router.refresh();
    });

  const run = () =>
    start(async () => {
      setResult(null);
      const r = await backtestAction({ id, json: dirty ? json : undefined, days: Number(days) });
      if (!r.ok) return void toast.error(r.error);
      if (r.data.issues.length) return setIssues(r.data.issues);
      setIssues([]);
      setResult({ hits: r.data.hits, evaluated: r.data.evaluated, truncated: r.data.truncated });
    });

  return (
    <>
      <Panel title="Definition" description={canEdit ? "Edit the JSON and save to create a new version. The id and type cannot change." : "Read only: only admins can edit rules."}>
        <Textarea
          aria-label="Rule JSON"
          value={json}
          onChange={(e) => edit(e.target.value)}
          readOnly={!canEdit}
          spellCheck={false}
          rows={24}
          className="font-mono text-xs"
          aria-invalid={issues.length > 0 || undefined}
          aria-describedby={issues.length ? "rule-issues" : undefined}
        />
        {issues.length > 0 && (
          <ul id="rule-issues" role="alert" className="mt-2 space-y-1 rounded-md border border-danger-border bg-danger-bg p-3 text-xs text-danger">
            {issues.map((i, n) => (
              <li key={n}>
                <span className="font-mono">{i.path || "(rule)"}</span>: {i.message}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canEdit && (
            <Button onClick={save} disabled={pending || !dirty}>
              <Save aria-hidden />
              Save new version
            </Button>
          )}
          {canEdit && dirty && (
            <Button variant="ghost" onClick={() => edit(initial)} disabled={pending}>
              Discard changes
            </Button>
          )}
        </div>
      </Panel>
      <Panel
        title="Backtest"
        description="Replays stored events through the rule (your unsaved edits if any) and shows what would have fired. Nothing is written."
        actions={
          <div className="flex items-center gap-2">
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger size="sm" className="w-28" aria-label="Backtest period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["1", "3", "7", "14", "30"].map((d) => (
                  <SelectItem key={d} value={d}>
                    Last {d} day{d === "1" ? "" : "s"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={run} disabled={pending}>
              <FlaskConical aria-hidden />
              {pending ? "Running…" : "Run backtest"}
            </Button>
          </div>
        }
      >
        {!result ? (
          <p className="text-sm text-text-muted">Run a backtest to see the alerts this rule would raise.</p>
        ) : (
          <div className="space-y-2" data-testid="backtest-result">
            <p className="text-sm">
              {result.hits.length} alert{result.hits.length === 1 ? "" : "s"} over {result.evaluated} evaluated events{result.truncated ? " (limited to the first 50,000 events)" : ""}.
            </p>
            <ul className="max-h-80 space-y-1.5 overflow-auto">
              {result.hits.map((h, n) => (
                <li key={n} className="rounded-md border border-border p-2 text-xs">
                  <span className="text-text-muted tabular-nums">{h.at.slice(0, 19).replace("T", " ")}</span> · {h.summary}
                  <span className="text-text-muted">
                    {" "}
                    · {h.count} hit{h.count === 1 ? "" : "s"}
                    {h.simulated ? " · simulated" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </>
  );
}
