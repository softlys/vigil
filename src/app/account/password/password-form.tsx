"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/patterns/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changePasswordAction } from "@/server/actions/auth";

export function PasswordForm() {
  const router = useRouter();
  const [values, setValues] = useState({ current: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValues({ ...values, [k]: e.target.value });
    setErrors({ ...errors, [k]: "" });
    setFormError(null);
  };
  return (
    <form
      className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-xs"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await changePasswordAction(values);
          if (!r.ok) {
            setErrors(Object.fromEntries(Object.entries(r.fieldErrors ?? {}).map(([k, v]) => [k, v[0] ?? ""])));
            setFormError(r.fieldErrors ? null : r.error);
            return;
          }
          toast.success("Password changed. Other sessions were signed out.");
          router.push("/");
          router.refresh();
        });
      }}
    >
      <FormField id="current" label="Current password" error={errors.current || undefined}>
        <Input id="current" type="password" autoComplete="current-password" value={values.current} onChange={set("current")} required maxLength={200} />
      </FormField>
      <FormField id="next" label="New password" hint="At least 12 characters." error={errors.next || undefined}>
        <Input id="next" type="password" autoComplete="new-password" value={values.next} onChange={set("next")} required minLength={12} maxLength={200} />
      </FormField>
      <FormField id="confirm" label="Repeat the new password" error={errors.confirm || undefined}>
        <Input id="confirm" type="password" autoComplete="new-password" value={values.confirm} onChange={set("confirm")} required maxLength={200} />
      </FormField>
      {formError && (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
