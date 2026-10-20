import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type KpiDelta = {
  /** Relative change versus the comparison period, e.g. 0.12 for +12%. Null when not comparable. */
  value: number | null;
  /** Whether an increase is good (revenue) or bad (overdue tasks). */
  positiveIsGood?: boolean;
  label?: string;
  /** Shown instead of the change when value is null (nothing to compare against). */
  emptyLabel?: string;
};

export function KpiCard({
  label,
  value,
  hint,
  delta,
  href,
  illustrative = false,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: KpiDelta;
  /** Drill-down target. The whole card becomes a link. */
  href?: string;
  /** Marks a number that is not computed from data. */
  illustrative?: boolean;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm text-text-muted">{label}</span>
        {illustrative && <span className="rounded border border-warning-border bg-warning-bg px-1 text-[11px] font-medium text-warning">Illustrative</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
      <div className="mt-1.5 min-h-5 space-y-0.5 text-xs text-text-muted">
        {delta && (
          <div>
            <DeltaPill delta={delta} />
          </div>
        )}
        {hint && <div className="truncate">{hint}</div>}
      </div>
    </>
  );
  const classes = cn(
    "block rounded-lg border border-border bg-surface p-4 shadow-xs transition-colors",
    href && "hover:border-border-strong hover:bg-surface-subtle focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
    className,
  );
  return href ? (
    <Link href={href} className={classes}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}

function DeltaPill({ delta }: { delta: KpiDelta }) {
  if (delta.value === null) return <span className="text-text-muted">{delta.emptyLabel ?? "No prior data to compare"}</span>;
  const up = delta.value > 0;
  const flat = Math.abs(delta.value) < 0.005;
  const good = flat ? null : up === (delta.positiveIsGood ?? true);
  const Icon = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-0.5 font-medium tabular-nums", good === null ? "text-text-muted" : good ? "text-success" : "text-danger")}>
      <Icon className="size-3.5" aria-hidden />
      {`${up ? "+" : ""}${(delta.value * 100).toFixed(1)}%`}
      {delta.label && <span className="ml-1 font-normal whitespace-nowrap text-text-muted">{delta.label}</span>}
    </span>
  );
}
