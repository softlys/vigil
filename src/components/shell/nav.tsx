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
  { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
  { href: "/help", label: "How VIGIL works", icon: BookOpenCheck },
];

/** Settings is admin-only, so analysts do not see a link that would only answer 403. */
export function Nav({ openIncidents, isAdmin }: { openIncidents: number; isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto md:flex-col">
      {ITEMS.filter((i) => isAdmin || !i.adminOnly).map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm whitespace-nowrap text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
              active && "bg-brand font-medium text-brand-foreground shadow-md shadow-brand/30 hover:bg-brand hover:text-brand-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
            {href === "/incidents" && openIncidents > 0 && (
              <span className={cn("ml-auto rounded-full px-1.5 text-[11px] font-semibold tabular-nums", active ? "bg-white/20 text-white" : "bg-danger-solid text-white")} aria-label={`${openIncidents} open incidents`}>
                {openIncidents}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
