"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { setRuleEnabledAction } from "@/server/actions/admin";

export function RuleToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Switch
      checked={enabled}
      disabled={pending}
      aria-label={`${enabled ? "Disable" : "Enable"} ${id}`}
      onCheckedChange={(next) =>
        start(async () => {
          const r = await setRuleEnabledAction({ id, enabled: next });
          if (!r.ok) return void toast.error(r.error);
          toast.success(`${id} ${next ? "enabled" : "disabled"}`);
          router.refresh();
        })
      }
    />
  );
}
