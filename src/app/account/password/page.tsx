import { ArrowLeft, KeyRound } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/session";
import { PasswordForm } from "./password-form";

export const metadata = { title: "Change password" };

/** Outside the (app) layout on purpose: users who must change their password can reach only this page. */
export default async function PasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/password");
  const forced = Boolean(user.must_change_password);
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        {!forced && (
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-foreground">
            <ArrowLeft className="size-4" aria-hidden />
            Back to VIGIL
          </Link>
        )}
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-brand text-brand-foreground">
            <KeyRound className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-semibold">{forced ? "Choose a new password" : "Change password"}</h1>
            <p className="text-xs text-text-muted">{user.email}</p>
          </div>
        </div>
        {forced && (
          <p className="rounded-lg border border-warning-border bg-warning-bg p-3 text-xs text-warning" role="note">
            Your password was set by an admin. Choose your own before you continue.
          </p>
        )}
        <PasswordForm />
      </div>
    </main>
  );
}
