import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Nav } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { connectorConfigured, getConfig } from "@/lib/config";
import { logoutAction } from "@/server/actions/auth";
import { db } from "@/server/db";
import { requireUser } from "@/server/session";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const sql = await db();
  const config = getConfig();
  const [{ n: openIncidents }] = await sql.query<{ n: number }>("select count(*)::int as n from incidents where status not in ('resolved', 'false_positive')");
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center gap-3 px-5 py-4">
          <span
            className="flex size-9 items-center justify-center rounded-xl text-white shadow-md shadow-brand/30"
            style={{ backgroundImage: "linear-gradient(135deg, var(--nx-color-accent-400), var(--nx-color-accent-700))" }}
          >
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight">VIGIL</p>
            <p className="text-[11px] text-sidebar-muted">Security monitoring for NEXORA</p>
          </div>
        </div>
        <div className="px-3 pb-2 md:flex-1">
          <Nav openIncidents={openIncidents ?? 0} isAdmin={user.role === "admin"} />
        </div>
        <div className="hidden border-t border-sidebar-border px-4 py-3 text-xs md:block">
          <p className="truncate font-medium">{user.name}</p>
          <p className="truncate text-sidebar-muted">
            {user.email} · {user.role}
          </p>
          <div className="mt-2 flex flex-col items-start">
            <Button asChild variant="ghost" size="sm" className="-ml-2 text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground">
              <Link href="/account/password">
                <KeyRound aria-hidden />
                Change password
              </Link>
            </Button>
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm" className="-ml-2 text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground">
                <LogOut aria-hidden />
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {config.simulator && (
          <div className="border-b border-warning-border bg-warning-bg px-4 py-1.5 text-xs text-warning sm:px-6" role="note" data-testid="simulated-banner">
            Demo mode: the simulator generates NEXORA-format events and scripted attacks. Everything marked Simulated is not real activity.
            {connectorConfigured(config) ? " The NEXORA connector is also configured: real events are shown alongside." : ""}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 md:hidden">
          <span className="truncate text-xs text-text-muted">
            {user.email} · {user.role}
          </span>
          <div className="flex items-center">
            <Button asChild variant="ghost" size="sm">
              <Link href="/account/password">Password</Link>
            </Button>
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
        <main id="main" className="mx-auto max-w-[1480px] space-y-6 px-4 py-6 sm:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
