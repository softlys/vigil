"use client";

import { Play, PlugZap, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/patterns/form-field";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { createUserAction, runArchiveAction, runScenarioAction, saveSettingsAction, testChannelAction, testConnectorAction, updateUserAction } from "@/server/actions/admin";

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
              setRunning(s.key);
              start(async () => {
                const r = await runScenarioAction({ key: s.key });
                setRunning(null);
                if (!r.ok) return void toast.error(r.error);
                toast.success(`${s.title}: ${r.data.stored} simulated events, ${r.data.alerts} new alerts`);
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
  return (
    <div className="flex flex-wrap items-end gap-3">
      <FormField id="retention-days" label="Keep events for (days)" hint="7–3650 days.">
        <Input id="retention-days" type="number" min={7} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className="w-32" />
      </FormField>
      <Button disabled={pending || Number(days) === retentionDays} onClick={() => save({ retention_days: Number(days), notify_min_severity: minSeverity, notify_simulated: notifySimulated })}>
        Save
      </Button>
      <Button
        variant="outline"
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

type UserRow = { id: string; email: string; name: string; role: "analyst" | "admin"; active: boolean; last_login_at: string | null };

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
              <th scope="col" className="hidden py-2 text-left font-medium sm:table-cell">Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-border last:border-0">
                <td className="py-2 pr-3">
                  <p className="font-medium">{u.name}</p>
                  <p className="text-xs text-text-muted">{u.email}</p>
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
                <td className="hidden py-2 text-xs text-text-muted sm:table-cell">{u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 16).replace("T", " ") : "never"}</td>
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
        <FormField id="new-password" label="Initial password" hint="At least 12 characters. Share it out of band.">
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
