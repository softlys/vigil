import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/patterns/status-badge";
import { cn } from "@/lib/utils";

export function SeverityBadge({ severity }: { severity: string }) {
  return <StatusBadge status={severity} dot />;
}

/** Shown on every simulated event, alert and incident. */
export function SimulatedBadge({ simulated }: { simulated: boolean }) {
  if (!simulated) return null;
  return <StatusBadge tone="warning" label="Simulated" className="text-[11px]" />;
}

export function Panel({ title, description, actions, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-border bg-surface shadow-xs", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageTitle({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-3xl text-sm text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Range links that keep the other query parameters. */
export function RangeLinks({ current, base, params, ranges = ["1h", "24h", "7d", "30d"] }: { current: string; base: string; params: Record<string, string | undefined>; ranges?: string[] }) {
  return (
    <div role="group" aria-label="Time range" className="inline-flex rounded-lg border border-border p-0.5">
      {ranges.map((r) => {
        const sp = new URLSearchParams(Object.entries({ ...params, range: r, page: undefined }).filter((e): e is [string, string] => Boolean(e[1])));
        return (
          <Link
            key={r}
            href={`${base}?${sp}`}
            aria-current={r === current ? "true" : undefined}
            className={cn("rounded-md px-2.5 py-1 text-xs text-text-subtle hover:text-foreground", r === current && "bg-surface-muted font-medium text-foreground")}
          >
            {r}
          </Link>
        );
      })}
    </div>
  );
}

export function Pagination({ page, total, pageSize, base, params }: { page: number; total: number; pageSize: number; base: string; params: Record<string, string | undefined> }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => `${base}?${new URLSearchParams(Object.entries({ ...params, page: String(p) }).filter((e): e is [string, string] => Boolean(e[1])))}`;
  return (
    <div className="flex items-center justify-between text-xs text-text-muted">
      <span>
        {total === 0 ? "No results" : `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`}
      </span>
      <div className="flex gap-2">
        {page > 1 && (
          <Link className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted" href={href(page - 1)}>
            Previous
          </Link>
        )}
        {page < pages && (
          <Link className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted" href={href(page + 1)}>
            Next
          </Link>
        )}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border-strong p-6 text-center text-sm text-text-muted">{children}</p>;
}

/** Shortens ids for tables while keeping the full value in a title. */
export function ShortId({ value, className }: { value: string | null; className?: string }) {
  if (!value) return <span className="text-text-muted">—</span>;
  const short = value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
  return (
    <span className={cn("font-mono text-xs", className)} title={value}>
      {short}
    </span>
  );
}

export function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function pageOf(v: string | string[] | undefined): number {
  const n = Number(first(v));
  return Number.isInteger(n) && n > 0 && n < 10_000 ? n : 1;
}
