"use client";

import { Area, AreaChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_COLORS, ChartContainer, ChartTooltip, chartAxis, chartGrid } from "@/components/patterns/chart-container";

type Point = { bucket: string; total: number; failures: number };

/** Unique, readable tick labels for each bucket size (UTC). */
export function bucketLabel(iso: string, bucketMinutes: number) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  if (bucketMinutes >= 1440) return date;
  if (bucketMinutes >= 180) return `${date} ${time}`;
  return time;
}

const UNIT: Record<number, string> = { 1: "minute", 30: "30 minutes", 180: "3 hours", 1440: "day" };

/** Events over time: all events and failures (authentication, authorization, integrations). */
export function EventsChart({ data, bucketMinutes }: { data: Point[]; bucketMinutes: number }) {
  const rows = data.map((d) => ({ ...d, label: bucketLabel(d.bucket, bucketMinutes) }));
  const perMinute = (v: number) => (v / bucketMinutes).toFixed(bucketMinutes === 1 ? 0 : 2);
  return (
    <ChartContainer
      title="Events"
      description={`Events per ${UNIT[bucketMinutes] ?? `${bucketMinutes} minutes`} (UTC). Failures are events with outcome failure.`}
      height={240}
      summary={`Events chart: ${rows.length} buckets, ${rows.reduce((s, r) => s + r.total, 0)} events, ${rows.reduce((s, r) => s + r.failures, 0)} failures.`}
      empty={rows.every((r) => r.total === 0) ? <p className="flex h-full items-center justify-center text-sm text-text-muted">No events in this range.</p> : undefined}
    >
      <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid {...chartGrid} />
        <XAxis dataKey="label" {...chartAxis} minTickGap={24} />
        <YAxis {...chartAxis} width={40} allowDecimals={false} />
        <Tooltip content={<ChartTooltip formatValue={(v: number) => `${v} (${perMinute(v)}/min)`} />} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="total" name="All events" stroke={CHART_COLORS[0]} fill={CHART_COLORS[0]} fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
        <Area type="monotone" dataKey="failures" name="Failures" stroke={CHART_COLORS[3]} fill={CHART_COLORS[3]} fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
      </AreaChart>
    </ChartContainer>
  );
}
