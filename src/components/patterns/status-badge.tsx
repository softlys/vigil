import { cn } from "@/lib/utils";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-surface-muted text-text-subtle border-border",
  accent: "bg-brand-subtle text-brand-subtle-foreground border-transparent",
  success: "bg-success-bg text-success border-success-border",
  warning: "bg-warning-bg text-warning border-warning-border",
  danger: "bg-danger-bg text-danger border-danger-border",
  info: "bg-info-bg text-info border-info-border",
};

const dotClasses: Record<Tone, string> = {
  neutral: "bg-text-muted",
  accent: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

/** Default tone for statuses used across NEXORA, so the same word always has the same color. */
const STATUS_TONES: Record<string, Tone> = {
  // generic
  active: "success",
  inactive: "neutral",
  archived: "neutral",
  // lifecycle
  prospect: "info",
  customer: "success",
  partner: "accent",
  churned: "neutral",
  // leads
  new: "info",
  contacted: "accent",
  qualified: "success",
  unqualified: "neutral",
  converted: "success",
  // orders
  draft: "neutral",
  confirmed: "info",
  processing: "accent",
  shipped: "info",
  delivered: "success",
  cancelled: "neutral",
  // payments
  unpaid: "warning",
  partially_paid: "info",
  paid: "success",
  overdue: "danger",
  // tasks
  todo: "neutral",
  in_progress: "accent",
  done: "success",
  // priorities
  low: "neutral",
  medium: "info",
  high: "warning",
  urgent: "danger",
  // automation and integrations
  success: "success",
  failed: "danger",
  skipped: "neutral",
  running: "info",
  pending: "neutral",
  connected: "success",
  configured: "info",
  not_configured: "neutral",
  revoked: "neutral",
  error: "danger",
  won: "success",
  lost: "neutral",
  simulated: "warning",
  // VIGIL: severities, incidents, alerts, responses
  critical: "danger",
  info: "neutral",
  triaged: "accent",
  investigating: "warning",
  resolved: "success",
  false_positive: "neutral",
  open: "warning",
  closed: "neutral",
  proposed: "warning",
  executed: "success",
  rejected: "neutral",
  failure: "danger",
};

export function toneForStatus(status: string): Tone {
  return STATUS_TONES[status] ?? "neutral";
}

const ACRONYMS = new Set(["api", "id", "url", "ip", "sso", "mfa", "crm"]);

export function humanizeStatus(status: string): string {
  const words = status.split("_").map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w));
  const label = words.join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function StatusBadge({
  status,
  label,
  tone,
  dot = false,
  className,
}: {
  status?: string;
  label?: string;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  const resolvedTone = tone ?? (status ? toneForStatus(status) : "neutral");
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap",
        toneClasses[resolvedTone],
        className,
      )}
    >
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full", dotClasses[resolvedTone])} />}
      {label ?? (status ? humanizeStatus(status) : "")}
    </span>
  );
}
