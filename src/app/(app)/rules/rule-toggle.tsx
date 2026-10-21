"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/patterns/confirm-dialog";
import { FormField } from "@/components/patterns/form-field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setRuleEnabledAction } from "@/server/actions/admin";

/**
 * Turning a rule on is immediate. Turning it off asks for confirmation and a reason, because the
 * rule's detections stop until someone turns it back on. Integrity rules cannot be turned off.
 */
export function RuleToggle({ id, title, enabled, locked = false }: { id: string; title: string; enabled: boolean; locked?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");

  if (locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            <Switch checked disabled aria-label={`${id} is always on`} />
          </span>
        </TooltipTrigger>
        <TooltipContent>Integrity rules are always on: they detect gaps and tampering in the event stream.</TooltipContent>
      </Tooltip>
    );
  }

  const enable = () =>
    start(async () => {
      const r = await setRuleEnabledAction({ id, enabled: true });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${id} enabled`);
      router.refresh();
    });

  return (
    <>
      <Switch checked={enabled} disabled={pending} aria-label={`${enabled ? "Disable" : "Enable"} ${id}`} onCheckedChange={(next) => (next ? enable() : setConfirming(true))} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => {
          setConfirming(o);
          if (!o) setReason("");
        }}
        title={`Turn off ${id}?`}
        description={`“${title}” stops raising alerts until it is turned back on. The change and your reason go to the audit log.`}
        confirmLabel="Turn off rule"
        destructive
        onConfirm={async () => {
          if (reason.trim().length < 5) {
            toast.error("Explain why the rule is turned off (at least 5 characters).");
            return false;
          }
          const r = await setRuleEnabledAction({ id, enabled: false, reason });
          if (!r.ok) {
            toast.error(r.fieldErrors ? (Object.values(r.fieldErrors).flat()[0] ?? r.error) : r.error);
            return false;
          }
          toast.success(`${id} disabled`);
          setReason("");
          router.refresh();
        }}
      >
        <FormField id={`disable-reason-${id}`} label="Reason (required)" hint="At least 5 characters, e.g. a known false positive being tuned.">
          <Textarea id={`disable-reason-${id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </FormField>
      </ConfirmDialog>
    </>
  );
}
