"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/patterns/form-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { addNoteAction, approveResponseAction, assignIncidentAction, proposeResponseAction, rejectResponseAction, setIncidentStatusAction } from "@/server/actions/incidents";

const STATUSES = [
  ["new", "New"],
  ["triaged", "Triaged"],
  ["investigating", "Investigating"],
  ["resolved", "Resolved"],
  ["false_positive", "False positive"],
] as const;
const NOBODY = "__nobody";

export function IncidentControls({ incidentId, status, assigneeId, users }: { incidentId: string; status: string; assigneeId: string | null; users: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [next, setNext] = useState(status);
  const [note, setNote] = useState("");
  const closing = next === "resolved" || next === "false_positive";

  const save = () =>
    start(async () => {
      const r = await setIncidentStatusAction({ id: incidentId, status: next, note });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Status updated");
      setNote("");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <FormField id="incident-status" label="Status">
        <Select value={next} onValueChange={setNext}>
          <SelectTrigger id="incident-status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {closing && (
        <FormField id="resolution-note" label="Resolution note" hint="Required when resolving or marking a false positive.">
          <Textarea id="resolution-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </FormField>
      )}
      <Button onClick={save} disabled={pending || next === status}>
        {pending ? "Saving…" : "Update status"}
      </Button>
      <FormField id="incident-assignee" label="Assignee">
        <Select
          value={assigneeId ?? NOBODY}
          onValueChange={(v) =>
            start(async () => {
              const r = await assignIncidentAction({ id: incidentId, assignee_id: v === NOBODY ? null : v });
              if (!r.ok) return void toast.error(r.error);
              toast.success("Assignee updated");
              router.refresh();
            })
          }
        >
          <SelectTrigger id="incident-assignee" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NOBODY}>Unassigned</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    </div>
  );
}

export function NoteForm({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addNoteAction({ id: incidentId, body });
          if (!r.ok) return void toast.error(r.error);
          setBody("");
          router.refresh();
        });
      }}
    >
      <FormField id="note" label="Add a note">
        <Textarea id="note" rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder="Findings, decisions, next steps…" />
      </FormField>
      <Button type="submit" variant="outline" size="sm" disabled={pending || body.trim() === ""}>
        Add note
      </Button>
    </form>
  );
}

export function ProposeResponse({ incidentId, users, keys }: { incidentId: string; users: string[]; keys: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const propose = (kind: "revoke_api_key" | "disable_user", target: string) =>
    start(async () => {
      const r = await proposeResponseAction({ incident_id: incidentId, kind, target_id: target, target_label: null });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Proposed. An admin must approve it.");
      router.refresh();
    });
  if (users.length === 0 && keys.length === 0) return <p className="text-xs text-text-muted">No NEXORA user or API key is involved in this incident.</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-text-muted">Propose an action</p>
      {keys.map((k) => (
        <Button key={k} variant="outline" size="sm" className="w-full justify-start" disabled={pending} onClick={() => propose("revoke_api_key", k)}>
          Revoke API key <span className="truncate font-mono text-[11px]">{k}</span>
        </Button>
      ))}
      {users.map((u) => (
        <Button key={u} variant="outline" size="sm" className="w-full justify-start" disabled={pending} onClick={() => propose("disable_user", u)}>
          Disable user <span className="truncate font-mono text-[11px]">{u}</span>
        </Button>
      ))}
    </div>
  );
}

/** Admin approval or rejection, always with a reason. */
export function ResponseDecision({ actionId, incidentId, label, simulated }: { actionId: string; incidentId: string; label: string; simulated: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const fn = mode === "approve" ? approveResponseAction : rejectResponseAction;
      const r = await fn({ action_id: actionId, incident_id: incidentId, reason });
      if (!r.ok) return void toast.error(r.error);
      if (mode === "approve") {
        const res = r.data as { status: string; simulated: boolean };
        if (res.status === "executed") toast.success(res.simulated ? "Executed (simulated: nothing was sent to NEXORA)" : "Executed in NEXORA");
        else toast.error("The action failed. See the timeline for the response.");
      } else toast.success("Rejected");
      setMode(null);
      setReason("");
      router.refresh();
    });
  return (
    <div className="mt-2 flex gap-2">
      <Button size="sm" onClick={() => setMode("approve")}>
        Approve
      </Button>
      <Button size="sm" variant="outline" onClick={() => setMode("reject")}>
        Reject
      </Button>
      <Dialog open={mode !== null} onOpenChange={(o) => !o && !pending && setMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === "approve" ? "Approve and execute" : "Reject"}: {label}</DialogTitle>
            <DialogDescription>
              {mode === "approve"
                ? simulated
                  ? "This incident is simulated: the action is recorded, but no request is sent to NEXORA."
                  : "VIGIL calls the NEXORA security-actions API now. This affects real users or integrations."
                : "The proposed action is closed without running."}
            </DialogDescription>
          </DialogHeader>
          <FormField id="decision-reason" label="Reason (required)" hint="Stored in the incident timeline and the audit log, and sent to NEXORA with the action.">
            <Textarea id="decision-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant={mode === "approve" ? "danger" : "default"} onClick={submit} disabled={pending || reason.trim().length < 5}>
              {pending ? "Working…" : mode === "approve" ? "Approve and execute" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
