"use client";

import { Activity, BookOpenCheck, FileClock, LayoutDashboard, ListChecks, Settings, ShieldAlert, Siren } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/events", label: "Events", icon: Activity },
  { href: "/incidents", label: "Incidents", icon: Siren },
  { href: "/alerts", label: "Alerts", icon: ShieldAlert },
  { href: "/rules", label: "Rules", icon: ListChecks },
  { href: "/audit", label: "Audit log", icon: FileClock },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/help", label: "How VIGIL works", icon: BookOpenCheck },
];

export function Nav({ openIncidents }: { openIncidents: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto md:flex-col">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-text-subtle hover:bg-surface-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              active && "bg-surface-muted font-medium text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
            {href === "/incidents" && openIncidents > 0 && (
              <span className="ml-auto rounded-full bg-danger-bg px-1.5 text-[11px] font-medium text-danger tabular-nums" aria-label={`${openIncidents} open incidents`}>
                {openIncidents}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
