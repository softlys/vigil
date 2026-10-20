import { ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { DEMO_USERS, demoPassword } from "@/lib/bootstrap";
import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/server/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  const demo = getConfig().mode === "demo";
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-brand text-brand-foreground">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-semibold">VIGIL</h1>
            <p className="text-xs text-text-muted">Security monitoring for NEXORA</p>
          </div>
        </div>
        <LoginForm />
        {demo && (
          <div className="space-y-1.5 rounded-lg border border-warning-border bg-warning-bg p-3 text-xs text-warning" data-testid="demo-credentials">
            <p className="font-medium">Demo mode: simulated events only</p>
            {DEMO_USERS.map((u) => (
              <p key={u.email}>
                {u.role === "admin" ? "Admin" : "Analyst"}: <span className="font-mono">{u.email}</span>
              </p>
            ))}
            <p>
              Password: <span className="font-mono">{demoPassword()}</span>
            </p>
            <p className="text-text-muted">Production mode has no demo accounts. See docs/deployment.md.</p>
          </div>
        )}
      </div>
    </main>
  );
}
