import { ArrowLeft, Smartphone } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { getConfig } from "@/lib/config";
import { generateTotpSecret, otpauthUri } from "@/lib/totp";
import { db as getSql } from "@/server/db";
import { getCurrentUser, mustSetUpMfa } from "@/server/session";
import { loadFactorUser } from "@/server/two-factor";
import { TwoFactorManage, TwoFactorSetup } from "./two-factor-forms";

export const metadata = { title: "Two-factor sign-in" };

/** Outside the (app) layout on purpose: users who must set up a second factor can reach only this page. */
export default async function TwoFactorPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/two-factor");
  if (user.must_change_password) redirect("/account/password?first=1");
  const forced = mustSetUpMfa(user);
  const sql = await getSql();
  let factor = await loadFactorUser(sql, user.id);
  if (!factor.totp_enabled && !factor.totp_secret) {
    // The secret is kept from the first visit until setup succeeds, so a reload shows the same QR code.
    await sql.query("update users set totp_secret = $2, totp_last_step = null where id = $1 and totp_secret is null", [user.id, generateTotpSecret()]);
    factor = await loadFactorUser(sql, user.id);
  }
  const uri = otpauthUri(factor.totp_secret!, user.email);
  const qr = factor.totp_enabled ? null : await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b1220", light: "#ffffff" } });

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        {!forced && (
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-foreground">
            <ArrowLeft className="size-4" aria-hidden />
            Back to VIGIL
          </Link>
        )}
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-brand text-brand-foreground">
            <Smartphone className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Two-factor sign-in</h1>
            <p className="text-xs text-text-muted">{user.email}</p>
          </div>
        </div>
        {forced && (
          <p className="rounded-lg border border-warning-border bg-warning-bg p-3 text-xs text-warning" role="note">
            This VIGIL requires two-factor sign-in. Set it up to continue.
          </p>
        )}
        {factor.totp_enabled ? (
          <TwoFactorManage recoveryCodesLeft={factor.recovery_codes.length} canDisable={!getConfig().requireMfa} />
        ) : (
          <TwoFactorSetup qrSvg={qr!} secret={factor.totp_secret!} />
        )}
      </div>
    </main>
  );
}
