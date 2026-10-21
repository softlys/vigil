"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * Confirmation for destructive or irreversible actions.
 * Uncontrolled with a `trigger`, or controlled with `open` / `onOpenChange`.
 * `onConfirm` may be async; the dialog stays open and shows progress until it settles,
 * and stays open when it returns false.
 */
export function ConfirmDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  children,
}: {
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  /** Label of the dismiss button; avoid "Cancel" when the action itself is a cancellation. */
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<boolean | void> | boolean | void;
  children?: ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button
            variant={destructive ? "danger" : "default"}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await onConfirm();
                if (result !== false) setOpen(false);
              })
            }
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
