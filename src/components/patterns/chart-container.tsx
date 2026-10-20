"use client";

import type { ReactNode } from "react";
import { ResponsiveContainer, type TooltipContentProps } from "recharts";
import { cn } from "@/lib/utils";

/** Series colors from the design tokens, in a fixed order for consistency across charts. */
export const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] as const;

/** Shared axis and grid styling for Recharts. Spread onto XAxis / YAxis / CartesianGrid. */
export const chartAxis = {
  tick: { fill: "var(--nx-text-muted)", fontSize: 12 },
  tickLine: false,
  axisLine: { stroke: "var(--nx-border)" },
} as const;
export const chartGrid = { stroke: "var(--nx-border)", strokeDasharray: "3 3", vertical: false } as const;

/**
 * Card wrapper for every chart: title, optional description and actions,
 * fixed height, and an accessible summary for screen readers.
 */
export function ChartContainer({
  title,
  description,
  actions,
  height = 260,
  summary,
  children,
  empty,
  footer,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  height?: number;
  /** Text alternative describing what the chart shows. */
  summary: string;
  children: ReactNode;
  /** Shown instead of the chart when there is nothing to plot. */
  empty?: ReactNode;
  /** Rendered under the chart (for example a "Show data" table). */
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("rounded-lg border border-border bg-surface p-4 shadow-xs", className)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <figcaption className="text-sm font-medium text-foreground">{title}</figcaption>
          {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      <div style={{ height }} role="img" aria-label={summary}>
        {empty ?? (
          <ResponsiveContainer width="100%" height="100%">
            {children as React.ReactElement}
          </ResponsiveContainer>
        )}
      </div>
      {footer}
    </figure>
  );
}

/** Tooltip body styled to the tokens. Pass as `content` to Recharts <Tooltip>. */
export function ChartTooltip({
  active,
  payload,
  label,
  formatValue = (v) => String(v),
}: Partial<TooltipContentProps<number, string>> & { formatValue?: (value: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      {label !== undefined && <div className="mb-1 font-medium text-foreground">{String(label)}</div>}
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2 text-text-subtle">
          <span className="size-2 rounded-sm" style={{ background: p.color }} aria-hidden />
          <span>{p.name}</span>
          <span className="ml-auto font-medium text-foreground tabular-nums">{formatValue(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}
