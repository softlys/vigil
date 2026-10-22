import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from "lucide-react";
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

export type KpiTone = "brand" | "success" | "warning" | "danger" | "info";

const TONES: Record<KpiTone, { tile: string; line: string }> = {
  brand: { tile: "bg-brand-subtle text-brand-subtle-foreground", line: "var(--nx-accent)" },
  success: { tile: "bg-success-bg text-success", line: "var(--nx-success-fg)" },
  warning: { tile: "bg-warning-bg text-warning", line: "var(--nx-warning-fg)" },
  danger: { tile: "bg-danger-bg text-danger", line: "var(--nx-danger-fg)" },
  info: { tile: "bg-info-bg text-info", line: "var(--nx-info-fg)" },
};

export function KpiCard({
  label,
  value,
  hint,
  delta,
  href,
  icon: Icon,
  tone = "brand",
  spark,
  illustrative = false,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: KpiDelta;
  /** Drill-down target. The whole card becomes a link. */
  href?: string;
  /** Icon shown in a colored tile next to the label. */
  icon?: LucideIcon;
  tone?: KpiTone;
  /** Values over the period, oldest first, drawn as a small trend line (decorative; the number is the data). */
  spark?: number[];
  /** Marks a number that is not computed from data. */
  illustrative?: boolean;
  className?: string;
}) {
  const t = TONES[tone];
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 pt-0.5 text-sm font-medium text-text-subtle">{label}</span>
        {Icon && (
          <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", t.tile)}>
            <Icon className="size-[18px]" aria-hidden />
          </span>
        )}
        {illustrative && <span className="rounded border border-warning-border bg-warning-bg px-1 text-[11px] font-medium text-warning">Illustrative</span>}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="min-w-0 text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
        {spark && spark.length > 1 && <Sparkline values={spark} color={t.line} className="mb-1 hidden sm:block" />}
      </div>
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
    "block rounded-xl border border-border bg-surface p-4 shadow-sm transition-all",
    href && "hover:-translate-y-px hover:border-border-strong hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
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

/** A small area trend line. Hidden from assistive tech: the card's number and delta carry the meaning. */
export function Sparkline({ values, color, className }: { values: number[]; color: string; className?: string }) {
  const w = 56;
  const h = 24;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn("h-6 w-14 shrink-0 overflow-visible", className)} aria-hidden>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
