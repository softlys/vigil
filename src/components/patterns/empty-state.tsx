import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Empty state: says what the area holds and offers at most one real next step.
 * Never render an action that does nothing.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface-subtle px-6 py-12 text-center", className)}>
      {Icon && (
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-text-muted shadow-xs">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <h2 className="text-md font-semibold text-foreground">{title}</h2>
      {description && <div className="mt-1.5 max-w-md text-sm text-text-muted">{description}</div>}
      {children && <div className="mt-5 w-full max-w-lg">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
