"use client";

import { useActionState } from "react";
import { FormField } from "@/components/patterns/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cancelMfaAction, loginAction, verifyMfaAction, type LoginState, type MfaState } from "@/server/actions/auth";

export function LoginForm({ next, mfaPending = false }: { next?: string; mfaPending?: boolean }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, { error: null, email: "" });
  const [mfa, mfaAction, mfaBusy] = useActionState<MfaState, FormData>(verifyMfaAction, { error: null });
  // The code step: after a correct password, or on reload while the pending sign-in is valid.
  if ((state.mfa || mfaPending) && !mfa.done) {
    return (
      <div className="space-y-3">
        <form action={mfaAction} className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-xs" data-testid="mfa-step">
          {next && <input type="hidden" name="next" value={next} />}
          <div>
            <p className="font-medium">Two-factor sign-in</p>
            <p className="text-xs text-text-muted">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
          </div>
          <FormField id="code" label="Code">
            <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={40} className="font-mono tracking-widest" />
          </FormField>
          {mfa.error && (
            <p role="alert" className="text-sm text-danger">
              {mfa.error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={mfaBusy}>
            {mfaBusy ? "Checking…" : "Verify"}
          </Button>
        </form>
        <form action={cancelMfaAction}>
          <Button type="submit" variant="ghost" size="sm" className="text-text-muted">
            Use a different account
          </Button>
        </form>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-xs">
      {next && <input type="hidden" name="next" value={next} />}
      <FormField id="email" label="Email">
        <Input id="email" name="email" type="email" autoComplete="username" required defaultValue={state.email} key={state.email} />
      </FormField>
      <FormField id="password" label="Password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required autoFocus={Boolean(state.email)} />
      </FormField>
      {(mfa.done ? mfa.error : state.error) && (
        <p role="alert" className="text-sm text-danger">
          {mfa.done ? mfa.error : state.error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-xs text-text-muted">Accounts with two-factor sign-in are asked for a code next. Production deployments should also sit behind SSO. See docs/deployment.md.</p>
    </form>
  );
}
