"use client";

import { Play, PlugZap, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/patterns/confirm-dialog";
import { FormField } from "@/components/patterns/form-field";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { createUserAction, deleteUserAction, resetUserPasswordAction, runArchiveAction, runScenarioAction, saveSettingsAction, testChannelAction, testConnectorAction, updateUserAction } from "@/server/actions/admin";

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

export function ConnectorTest({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={disabled || pending}
      onClick={() =>
        start(async () => {
          const r = await testConnectorAction({});
          if (!r.ok) return void toast.error(r.error);
          if (r.data.error) toast.error(`Poll failed: ${r.data.error}`);
          else toast.success(`Connected: ${r.data.stored} new events`);
          router.refresh();
        })
      }
    >
      <PlugZap aria-hidden />
      {pending ? "Polling…" : "Test connection and poll now"}
    </Button>
  );
}

export function ScenarioRunner({ scenarios }: { scenarios: Array<{ key: string; title: string; rules: string[] }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [running, setRunning] = useState<string | null>(null);
  // A second click before React re-renders the disabled button must not start a second run.
  const busy = useRef(false);
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {scenarios.map((s) => (
        <li key={s.key} className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm">{s.title}</p>
            <p className="font-mono text-[11px] text-text-muted">{s.rules.join(", ")}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            data-testid={`run-${s.key}`}
            onClick={() => {
              if (busy.current) return;
              busy.current = true;
              setRunning(s.key);
              start(async () => {
                const r = await runScenarioAction({ key: s.key });
                busy.current = false;
                setRunning(null);
                if (!r.ok) return void toast.error(r.error);
                const parts = [plural(r.data.stored, "simulated event"), plural(r.data.alerts, "new alert")];
                if (r.data.updated > 0) parts.push(`${plural(r.data.updated, "existing alert")} updated`);
                toast.success(`${s.title}: ${parts.join(", ")}`);
                router.refresh();
              });
            }}
          >
            <Play aria-hidden />
            {running === s.key ? "Running…" : "Run"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function ChannelTest({ channel }: { channel: "email" | "slack" | "webhook" }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await testChannelAction({ channel });
          if (!r.ok) return void toast.error(r.error);
          toast.success("Test notification sent");
        })
      }
    >
      <Send aria-hidden />
      Send test
    </Button>
  );
}

function useSettingsSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const save = (values: { retention_days: number; notify_min_severity: string; notify_simulated: boolean }) =>
    start(async () => {
      const r = await saveSettingsAction(values);
      if (!r.ok) return void toast.error(r.fieldErrors ? Object.values(r.fieldErrors).flat()[0] ?? r.error : r.error);
      toast.success("Settings saved");
      router.refresh();
    });
  return { pending, save };
}

export function NotificationSettings({ minSeverity, notifySimulated, retentionDays }: { minSeverity: string; notifySimulated: boolean; retentionDays: number }) {
  const { pending, save } = useSettingsSave();
  const [severity, setSeverity] = useState(minSeverity);
  const [simulated, setSimulated] = useState(notifySimulated);
  return (
    <div className="flex flex-wrap items-end gap-4 pt-2">
      <FormField id="notify-severity" label="Notify from severity">
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger id="notify-severity" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["critical", "high", "medium", "low"].map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <div className="flex items-center gap-2 pb-1.5">
        <Switch id="notify-simulated" checked={simulated} onCheckedChange={setSimulated} />
        <Label htmlFor="notify-simulated">Also notify for simulated alerts</Label>
      </div>
      <Button disabled={pending || (severity === minSeverity && simulated === notifySimulated)} onClick={() => save({ retention_days: retentionDays, notify_min_severity: severity, notify_simulated: simulated })}>
        Save
      </Button>
    </div>
  );
}

export function RetentionSettings({ retentionDays, minSeverity, notifySimulated }: { retentionDays: number; minSeverity: string; notifySimulated: boolean }) {
  const { pending, save } = useSettingsSave();
  const router = useRouter();
  const [days, setDays] = useState(String(retentionDays));
  const [archiving, start] = useTransition();
  const error = retentionError(days);
  return (
    <div className="flex flex-wrap items-start gap-3">
      <FormField id="retention-days" label="Keep events for (days)" hint="Between 7 and 3650 days (10 years)." error={error ?? undefined}>
        <Input id="retention-days" type="number" inputMode="numeric" min={7} max={3650} step={1} value={days} onChange={(e) => setDays(e.target.value)} className="w-32" aria-invalid={error ? true : undefined} />
      </FormField>
      <Button className="mt-6" disabled={pending || error !== null || Number(days) === retentionDays} onClick={() => save({ retention_days: Number(days), notify_min_severity: minSeverity, notify_simulated: notifySimulated })}>
        Save
      </Button>
      <Button
        variant="outline"
        className="mt-6"
        disabled={archiving}
        onClick={() =>
          start(async () => {
            const r = await runArchiveAction({});
            if (!r.ok) return void toast.error(r.error);
            toast.success(`Archive job ran: ${r.data.archived} events moved`);
            router.refresh();
          })
        }
      >
        Run archive job now
      </Button>
    </div>
  );
}

export function retentionError(value: string): string | null {
  if (value.trim() === "") return "Enter a number of days.";
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return "Use a whole number of days.";
  if (n < 7) return "Keep events for at least 7 days.";
  if (n > 3650) return "The maximum is 3650 days (10 years).";
  return null;
}

type UserRow = { id: string; email: string; name: string; role: "analyst" | "admin"; active: boolean; last_login_at: string | null; must_change_password?: boolean };

function UserActions({ user }: { user: UserRow }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-1.5">
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={(o) => {
          setResetOpen(o);
          if (!o) setPassword("");
        }}
        trigger={
          <Button size="sm" variant="outline">
            Reset password
          </Button>
        }
        title={`Reset the password of ${user.name}?`}
        description="Their sessions end now, and they must choose a new password the next time they sign in. Share the temporary password out of band."
        confirmLabel="Reset password"
        onConfirm={async () => {
          const r = await resetUserPasswordAction({ id: user.id, password });
          if (!r.ok) {
            toast.error(r.fieldErrors ? (Object.values(r.fieldErrors).flat()[0] ?? r.error) : r.error);
            return false;
          }
          toast.success(`Password reset for ${user.name}`);
          setPassword("");
          router.refresh();
        }}
      >
        <FormField id={`reset-${user.id}`} label="Temporary password" hint={`At least 12 characters${password.length > 0 && password.length < 12 ? ` (${12 - password.length} more)` : ""}.`}>
          <Input id={`reset-${user.id}`} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} maxLength={200} />
        </FormField>
      </ConfirmDialog>
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="ghost" className="text-danger">
            Delete
          </Button>
        }
        title={`Delete ${user.name}?`}
        description="The account and its sessions are removed. Its past actions stay in the audit log and incident timelines. To keep the account but block sign-in, deactivate it instead."
        confirmLabel="Delete user"
        destructive
        onConfirm={async () => {
          const r = await deleteUserAction({ id: user.id });
          if (!r.ok) {
            toast.error(r.error);
            return false;
          }
          toast.success(`${user.name} deleted`);
          router.refresh();
        }}
      />
    </div>
  );
}

export function Users({ users, currentUserId }: { users: UserRow[]; currentUserId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState({ email: "", name: "", role: "analyst", password: "" });
  const update = (u: UserRow, patch: Partial<Pick<UserRow, "role" | "active">>) =>
    start(async () => {
      const r = await updateUserAction({ id: u.id, role: patch.role ?? u.role, active: patch.active ?? u.active });
      if (!r.ok) return void toast.error(r.error);
      toast.success("User updated");
      router.refresh();
    });
  return (
    <div className="space-y-4">
      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Users</caption>
          <thead className="border-b border-border text-xs text-text-muted">
            <tr>
              <th scope="col" className="py-2 pr-3 text-left font-medium">User</th>
              <th scope="col" className="py-2 pr-3 text-left font-medium">Role</th>
              <th scope="col" className="py-2 pr-3 text-left font-medium">Active</th>
              <th scope="col" className="hidden py-2 pr-3 text-left font-medium sm:table-cell">Last sign-in</th>
              <th scope="col" className="py-2 text-left font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-border last:border-0">
                <td className="py-2 pr-3">
                  <p className="font-medium">{u.name}</p>
                  <p className="text-xs text-text-muted">{u.email}</p>
                  {u.must_change_password && <p className="text-[11px] text-warning">Must change password at next sign-in</p>}
                </td>
                <td className="py-2 pr-3">
                  <Select value={u.role} onValueChange={(v) => update(u, { role: v as UserRow["role"] })} disabled={pending || u.id === currentUserId}>
                    <SelectTrigger size="sm" className="w-28" aria-label={`Role of ${u.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="analyst">Analyst</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </td>
                <td className="py-2 pr-3">
                  <Switch checked={u.active} disabled={pending || u.id === currentUserId} onCheckedChange={(v) => update(u, { active: v })} aria-label={`${u.active ? "Deactivate" : "Activate"} ${u.name}`} />
                </td>
                <td className="hidden py-2 pr-3 text-xs text-text-muted sm:table-cell">{u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 16).replace("T", " ") : "never"}</td>
                <td className="py-2">{u.id === currentUserId ? <span className="text-xs text-text-muted">You</span> : <UserActions user={u} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await createUserAction(form);
            if (!r.ok) return void toast.error(r.fieldErrors ? Object.values(r.fieldErrors).flat()[0] ?? r.error : r.error);
            toast.success("User created");
            setForm({ email: "", name: "", role: "analyst", password: "" });
            router.refresh();
          });
        }}
      >
        <p className="text-sm font-medium sm:col-span-2">Add a user</p>
        <FormField id="new-name" label="Name">
          <Input id="new-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} />
        </FormField>
        <FormField id="new-email" label="Email">
          <Input id="new-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </FormField>
        <FormField id="new-role" label="Role">
          <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
            <SelectTrigger id="new-role" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="analyst">Analyst</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <FormField id="new-password" label="Initial password" hint="At least 12 characters. Share it out of band; the user must change it at first sign-in.">
          <Input id="new-password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={12} autoComplete="new-password" />
        </FormField>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            Create user
          </Button>
          <StatusBadge tone="neutral" label="Audited" className="ml-2" />
        </div>
      </form>
    </div>
  );
}
