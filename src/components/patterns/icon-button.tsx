"use client";

import type { LucideIcon } from "lucide-react";
import { forwardRef, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type IconButtonProps = Omit<ComponentProps<typeof Button>, "children" | "size"> & {
  icon: LucideIcon;
  /** Accessible name, also shown as tooltip. Required: icon-only buttons must be labelled. */
  label: string;
  size?: "sm" | "default" | "lg";
  showTooltip?: boolean;
};

const sizeMap = { sm: "icon-sm", default: "icon", lg: "icon-lg" } as const;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = "default", variant = "ghost", showTooltip = true, ...props },
  ref,
) {
  const button = (
    <Button ref={ref} variant={variant} size={sizeMap[size]} aria-label={label} {...props}>
      <Icon aria-hidden />
    </Button>
  );
  if (!showTooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});
