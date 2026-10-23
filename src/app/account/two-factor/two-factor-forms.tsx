"use client";

import { Copy } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/patterns/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { disableTwoFactorAction, enableTwoFactorAction, regenerateRecoveryCodesAction } from "@/server/actions/auth";

const panel = "space-y-4 rounded-lg border border-border bg-surface p-5 shadow-xs";

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className={panel} data-testid="recovery-codes">
      <div>
        <p className="font-medium">Save your recovery codes</p>
        <p className="text-xs text-text-muted">Each code signs you in once if you lose your phone. They are shown only now; store them in your password manager.</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 rounded-md bg-surface-muted p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(codes.join("\n"));
            toast.success("Recovery codes copied");
          }}
        >
          <Copy aria-hidden />
          Copy
        </Button>
        <Button onClick={onDone}>I saved them</Button>
      </div>
    </div>
  );
}

function CodeField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string | null }) {
  return (
    <FormField id="totp-code" label="Code from the app" error={error ?? undefined}>
      <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" value={value} onChange={(e) => onChange(e.target.value)} maxLength={40} className="font-mono tracking-widest" required />
    </FormField>
  );
}

export function TwoFactorSetup({ qrSvg, secret }: { qrSvg: string; secret: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, start] = useTransition();
  if (codes)
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          router.push("/");
          router.refresh();
        }}
      />
    );
  return (
    <form
      className={panel}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await enableTwoFactorAction({ code });
          if (!r.ok) return void setError(r.fieldErrors ? (Object.values(r.fieldErrors).flat()[0] ?? r.error) : r.error);
          toast.success("Two-factor sign-in is on");
          setCodes(r.data.recoveryCodes);
        });
      }}
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Open an authenticator app: Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden or similar.</li>
        <li>Scan the QR code, or enter the key by hand.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        <div className="size-44 shrink-0 overflow-hidden rounded-md bg-white p-1 [&_svg]:size-full" role="img" aria-label="QR code for the authenticator app" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        <div className="min-w-0 space-y-1 text-xs">
          <p className="text-text-muted">Key</p>
          <p className="break-all font-mono text-sm" data-testid="totp-secret">
            {secret.replace(/(.{4})/g, "$1 ").trim()}
          </p>
          <p className="text-text-muted">Time-based, 6 digits, 30 seconds.</p>
        </div>
      </div>
      <CodeField
        value={code}
        onChange={(v) => {
          setCode(v);
          setError(null);
        }}
        error={error}
      />
      <Button type="submit" className="w-full" disabled={pending || code.trim().length < 6}>
        {pending ? "Checking…" : "Turn on two-factor sign-in"}
      </Button>
    </form>
  );
}

export function TwoFactorManage({ recoveryCodesLeft, canDisable }: { recoveryCodesLeft: number; canDisable: boolean }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, start] = useTransition();
  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;
  const run = (kind: "regenerate" | "disable") =>
    start(async () => {
      setError(null);
      if (kind === "regenerate") {
        const r = await regenerateRecoveryCodesAction({ code });
        if (!r.ok) return void setError(r.fieldErrors ? (Object.values(r.fieldErrors).flat()[0] ?? r.error) : r.error);
        setCode("");
        setCodes(r.data.recoveryCodes);
        router.refresh();
      } else {
        const r = await disableTwoFactorAction({ code });
        if (!r.ok) return void setError(r.fieldErrors ? (Object.values(r.fieldErrors).flat()[0] ?? r.error) : r.error);
        toast.success("Two-factor sign-in is off");
        router.refresh();
      }
    });
  return (
    <div className={panel} data-testid="mfa-on">
      <div>
        <p className="font-medium text-success">Two-factor sign-in is on</p>
        <p className="text-xs text-text-muted">
          {recoveryCodesLeft} recovery code{recoveryCodesLeft === 1 ? "" : "s"} left.{recoveryCodesLeft <= 2 ? " Create new ones soon." : ""}
        </p>
      </div>
      <CodeField
        value={code}
        onChange={(v) => {
          setCode(v);
          setError(null);
        }}
        error={error}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={pending || code.trim().length < 6} onClick={() => run("regenerate")}>
          New recovery codes
        </Button>
        {canDisable && (
          <Button variant="ghost" className="text-danger" disabled={pending || code.trim().length < 6} onClick={() => run("disable")}>
            Turn off
          </Button>
        )}
      </div>
      {!canDisable && <p className="text-xs text-text-muted">This deployment requires two-factor sign-in, so it cannot be turned off. If you lose your phone and codes, an admin can reset it.</p>}
    </div>
  );
}
