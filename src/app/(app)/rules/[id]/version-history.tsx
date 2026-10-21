"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/patterns/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { lineDiff } from "@/lib/diff";
import { restoreRuleVersionAction } from "@/server/actions/admin";

type Version = { version: number; json: string; by: string; at: string };

/** Every saved version, with a line diff against the current one and (for admins) restore. */
export function VersionHistory({ id, current, versions, canEdit }: { id: string; current: number; versions: Version[]; canEdit: boolean }) {
  const router = useRouter();
  const [compare, setCompare] = useState<Version | null>(null);
  const latest = versions.find((v) => v.version === current);
  const diff = compare && latest ? lineDiff(compare.json, latest.json) : [];

  return (
    <>
      <ol className="space-y-2 text-sm">
        {versions.map((v) => (
          <li key={v.version} className="space-y-1" data-testid="rule-version">
            <div className="flex justify-between gap-2">
              <span className="font-medium">
                v{v.version}
                {v.version === current && <span className="ml-1.5 text-xs font-normal text-text-muted">current</span>}
              </span>
              <span className="text-xs text-text-muted">
                {v.by} · {v.at}
              </span>
            </div>
            {v.version !== current && (
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setCompare(v)}>
                  Compare with current
                </Button>
                {canEdit && (
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
                        Restore
                      </Button>
                    }
                    title={`Restore version ${v.version}?`}
                    description={`Its definition is saved as a new version (v${current + 1}). History is kept, so you can go back again.`}
                    confirmLabel={`Restore as v${current + 1}`}
                    onConfirm={async () => {
                      const r = await restoreRuleVersionAction({ id, version: v.version });
                      if (!r.ok) {
                        toast.error(r.error);
                        return false;
                      }
                      toast.success(`Version ${v.version} restored as v${r.data.version}`);
                      router.refresh();
                    }}
                  />
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      <Dialog open={compare !== null} onOpenChange={(o) => !o && setCompare(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {id}: v{compare?.version} → v{current}
            </DialogTitle>
            <DialogDescription>Lines removed since v{compare?.version} are red, lines added are green.</DialogDescription>
          </DialogHeader>
          {diff.every((d) => d.op === "same") ? (
            <p className="text-sm text-text-muted">The two versions are identical.</p>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-muted p-2 font-mono text-[11px] leading-relaxed" data-testid="rule-diff">
              {diff.map((d, n) => (
                <div key={n} className={d.op === "add" ? "bg-success-bg text-success" : d.op === "del" ? "bg-danger-bg text-danger" : "text-text-muted"}>
                  {d.op === "add" ? "+ " : d.op === "del" ? "- " : "  "}
                  {d.line}
                </div>
              ))}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
