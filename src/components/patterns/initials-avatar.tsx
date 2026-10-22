import { cn } from "@/lib/utils";

const HUES = ["bg-brand-subtle text-brand-subtle-foreground", "bg-info-bg text-info", "bg-success-bg text-success", "bg-warning-bg text-warning"];

/** Avatar with initials. The color is derived from the name, so a person always gets the same one. */
export function InitialsAvatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const hue = HUES[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % HUES.length];
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold", hue, className)} aria-hidden>
      {initials || "?"}
    </span>
  );
}
