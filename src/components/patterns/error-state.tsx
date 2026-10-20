import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ErrorState({
  title = "Something went wrong",
  description,
  reference,
  action,
  className,
}: {
  title?: string;
  description?: ReactNode;
  /** Short request or error id the user can quote. Never a stack trace. */
  reference?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex flex-col items-center rounded-lg border border-danger-border bg-danger-bg px-6 py-10 text-center", className)}>
      <CircleAlert className="mb-3 size-6 text-danger" aria-hidden />
      <h2 className="text-md font-semibold text-foreground">{title}</h2>
      {description && <div className="mt-1.5 max-w-md text-sm text-text-subtle">{description}</div>}
      {reference && <p className="mt-2 font-mono text-xs text-text-muted">Reference: {reference}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
