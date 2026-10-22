import { Bell, Gauge, HeartPulse, Link2, PlugZap, Radar, ShieldCheck, Timer, Workflow, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/patterns/status-badge";
import type { Posture } from "@/lib/posture";
import { cn } from "@/lib/utils";

/** Open alerts by severity as filter pills (reference: SOC header), each linking to the filtered list. */
export function SeverityPills({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pills: Array<{ key: string; label: string; n: number; href: string; className: string }> = [
    { key: "all", label: "All threats", n: total, href: "/alerts?status=open", className: "bg-brand text-brand-foreground shadow-md shadow-brand/30" },
    { key: "critical", label: "Critical", n: counts.critical ?? 0, href: "/alerts?status=open&severity=critical", className: "text-danger" },
    { key: "high", label: "High", n: counts.high ?? 0, href: "/alerts?status=open&severity=high", className: "text-warning" },
    { key: "medium", label: "Medium", n: counts.medium ?? 0, href: "/alerts?status=open&severity=medium", className: "text-info" },
    { key: "low", label: "Low", n: counts.low ?? 0, href: "/alerts?status=open&severity=low", className: "text-text-subtle" },
  ];
  return (
    <nav aria-label="Open alerts by severity" className="flex flex-wrap items-center gap-1 rounded-full border border-border bg-surface p-1">
      {pills.map((p) => (
        <Link key={p.key} href={p.href} className={cn("rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors hover:bg-surface-muted", p.className, p.key === "all" && "hover:bg-brand-hover")}>
          {p.label} <span className="ml-0.5 tabular-nums opacity-80">{p.n.toLocaleString("en-US")}</span>
        </Link>
      ))}
    </nav>
  );
}

const DAY = 86_400_000;

/**
 * Events per hour over the last 7 days (UTC): one row per day, one cell per hour, darker = more.
 * One orange hue from light to dark (a sequential scale); exact numbers are in each cell's label.
 */
export function ActivityHeatmap({ cells, now }: { cells: Array<{ day: string; hour: number; n: number; failures: number }>; now: Date }) {
  const today = Date.parse(now.toISOString().slice(0, 10));
  const days = Array.from({ length: 7 }, (_, i) => new Date(today - (6 - i) * DAY).toISOString().slice(0, 10));
  const map = new Map(cells.map((c) => [`${c.day}|${c.hour}`, c]));
  const max = Math.max(1, ...cells.map((c) => c.n));
  const total = cells.reduce((s, c) => s + c.n, 0);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-[3px]" aria-describedby="heatmap-summary">
          <caption id="heatmap-summary" className="sr-only">
            Events per hour for the last 7 days, {total} in total. Each cell lists the date, hour, events and failures.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-12" />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} scope="col" className="text-[10px] font-normal text-text-muted">
                  {h % 3 === 0 ? String(h).padStart(2, "0") : <span className="sr-only">{h}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d}>
                <th scope="row" className="pr-1 text-left text-[11px] font-normal whitespace-nowrap text-text-muted">
                  {new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}
                </th>
                {Array.from({ length: 24 }, (_, h) => {
                  const c = map.get(`${d}|${h}`);
                  const n = c?.n ?? 0;
                  const label = `${d} ${String(h).padStart(2, "0")}:00 UTC: ${n} event${n === 1 ? "" : "s"}${c?.failures ? `, ${c.failures} failed` : ""}`;
                  return (
                    <td key={h} className="p-0">
                      <span
                        title={label}
                        role="img"
                        aria-label={label}
                        className="block h-5 rounded-[4px] ring-brand/60 hover:ring-2"
                        style={{ backgroundColor: n === 0 ? "var(--nx-surface-muted)" : `color-mix(in oklab, var(--nx-color-accent-500) ${Math.round(20 + (n / max) * 80)}%, var(--nx-surface-muted))` }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5 text-[11px] text-text-muted" aria-hidden>
        Fewer
        {[0, 25, 50, 75, 100].map((p) => (
          <span key={p} className="size-3 rounded-[3px]" style={{ backgroundColor: p === 0 ? "var(--nx-surface-muted)" : `color-mix(in oklab, var(--nx-color-accent-500) ${20 + p * 0.8}%, var(--nx-surface-muted))` }} />
        ))}
        More
      </div>
    </div>
  );
}

/** The posture score with its deductions, so the number is never a black box. */
export function PostureCard({ posture }: { posture: Posture }) {
  const tone = posture.label === "Strong" ? "text-success" : posture.label === "Fair" ? "text-warning" : "text-danger";
  const bar = posture.label === "Strong" ? "var(--nx-success-fg)" : posture.label === "Fair" ? "var(--nx-warning-fg)" : "var(--nx-danger-fg)";
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-end justify-between gap-2">
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {posture.score}
          <span className="text-base font-normal text-text-muted">/100</span>
        </p>
        <span className={cn("text-sm font-medium", tone)}>{posture.label}</span>
      </div>
      <div className="mt-3 h-2 rounded-full bg-surface-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={posture.score} aria-label="Security posture score">
        <div className="h-2 rounded-full" style={{ width: `${posture.score}%`, backgroundColor: bar }} />
      </div>
      {posture.deductions.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">Nothing needs attention right now.</p>
      ) : (
        <ul className="mt-3 space-y-1 text-xs">
          {posture.deductions.slice(0, 4).map((d) => (
            <li key={d.reason} className="flex justify-between gap-2">
              <span className="text-text-subtle">{d.reason}</span>
              <span className="text-danger tabular-nums">−{d.points}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-auto pt-3 text-[11px] text-text-muted">100 minus open incidents by severity, recent integrity findings, rules turned off and connector failures.</p>
    </div>
  );
}

export type Component = { key: string; name: string; detail: string; state: "ok" | "warn" | "fail" | "off"; href?: string };

const COMPONENT_ICON: Record<string, { icon: LucideIcon; tile: string }> = {
  connector: { icon: PlugZap, tile: "bg-info-bg text-info" },
  worker: { icon: HeartPulse, tile: "bg-success-bg text-success" },
  rules: { icon: Radar, tile: "bg-brand-subtle text-brand-subtle-foreground" },
  integrity: { icon: Link2, tile: "bg-success-bg text-success" },
  notifications: { icon: Bell, tile: "bg-warning-bg text-warning" },
  response: { icon: ShieldCheck, tile: "bg-danger-bg text-danger" },
  simulator: { icon: Workflow, tile: "bg-surface-muted text-text-subtle" },
  retention: { icon: Timer, tile: "bg-info-bg text-info" },
};

const STATE: Record<Component["state"], { label: string; dot: string; text: string }> = {
  ok: { label: "Active", dot: "bg-success", text: "text-success" },
  warn: { label: "Attention", dot: "bg-warning", text: "text-warning" },
  fail: { label: "Failing", dot: "bg-danger", text: "text-danger" },
  off: { label: "Not configured", dot: "bg-text-muted", text: "text-text-muted" },
};

/** Monitoring components as tiles with a status dot (reference: "Security tools"). */
export function ComponentGrid({ items }: { items: Component[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((c) => {
        const icon = COMPONENT_ICON[c.key] ?? { icon: Gauge, tile: "bg-surface-muted text-text-subtle" };
        const s = STATE[c.state];
        const body = (
          <>
            <span className={cn("flex size-9 items-center justify-center rounded-xl", icon.tile)}>
              <icon.icon className="size-[18px]" aria-hidden />
            </span>
            <p className="mt-3 text-sm font-semibold">{c.name}</p>
            <p className="truncate text-xs text-text-muted">{c.detail}</p>
            <p className={cn("mt-2 flex items-center gap-1.5 text-xs font-medium", s.text)}>
              <span className={cn("size-1.5 rounded-full", s.dot)} aria-hidden />
              {s.label}
            </p>
          </>
        );
        return (
          <li key={c.key}>
            {c.href ? (
              <Link href={c.href} className="block h-full rounded-xl border border-border bg-surface-subtle p-3 transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                {body}
              </Link>
            ) : (
              <div className="h-full rounded-xl border border-border bg-surface-subtle p-3">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function minutes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 1) return `${Math.max(1, Math.round(value * 60))} s`;
  if (value < 120) return `${value.toFixed(1)} min`;
  if (value < 2880) return `${(value / 60).toFixed(1)} h`;
  return `${(value / 1440).toFixed(1)} d`;
}

export function IncidentList({ rows }: { rows: Array<{ id: string; title: string; severity: string; status: string; updated_at: string; simulated: boolean; alert_count: number }> }) {
  if (rows.length === 0) return <p className="text-sm text-text-muted">No open incidents.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((i) => (
        <li key={i.id}>
          <Link href={`/incidents/${i.id}`} className="flex items-center gap-3 rounded-lg border border-border bg-surface-subtle px-3 py-2.5 transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{i.title}</span>
              <span className="block text-xs text-text-muted">
                {i.alert_count} alert{i.alert_count === 1 ? "" : "s"} · {i.status.replace("_", " ")}
                {i.simulated ? " · simulated" : ""}
              </span>
            </span>
            <StatusBadge status={i.severity} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
