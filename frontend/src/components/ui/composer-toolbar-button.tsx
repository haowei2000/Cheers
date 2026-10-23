import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";
import { ControlTrigger } from "./control-trigger";

type ComposerToolbarButtonProps = ComponentPropsWithoutRef<typeof ControlTrigger>;

/**
 * Semantic composer selectors share the regular 96px slot. Current values
 * truncate inside it; full values remain in the accessible name and tooltip.
 */
export const ComposerToolbarButton = forwardRef<
  HTMLButtonElement,
  ComposerToolbarButtonProps
>(({ className, selected, children, ...props }, ref) => (
  <ControlTrigger
    ref={ref}
    controlSize="regular"
    selected={selected}
    className={cn("shrink-0", className)}
    {...props}
  >
    {children}
  </ControlTrigger>
));

ComposerToolbarButton.displayName = "ComposerToolbarButton";
