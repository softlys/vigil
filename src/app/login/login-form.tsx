"use client";

import { useActionState } from "react";
import { FormField } from "@/components/patterns/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loginAction, type LoginState } from "@/server/actions/auth";

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, { error: null, email: "" });
  return (
    <form action={formAction} className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-xs">
      {next && <input type="hidden" name="next" value={next} />}
      <FormField id="email" label="Email">
        <Input id="email" name="email" type="email" autoComplete="username" required defaultValue={state.email} key={state.email} />
      </FormField>
      <FormField id="password" label="Password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required autoFocus={Boolean(state.email)} />
      </FormField>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-xs text-text-muted">Production deployments must put VIGIL behind SSO with MFA. See docs/deployment.md.</p>
    </form>
  );
}
