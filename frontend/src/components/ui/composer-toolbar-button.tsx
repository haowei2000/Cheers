import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

type ComposerToolbarButtonProps = ComponentPropsWithoutRef<typeof Button>;

/**
 * Composer selectors use the shared regular icon+text slot. Their visible
 * labels must be short; the full current value belongs in the accessible name
 * and tooltip instead of being truncated inside the control.
 */
export const ComposerToolbarButton = forwardRef<
  HTMLButtonElement,
  ComposerToolbarButtonProps
>(({ className, variant = "plain", children, ...props }, ref) => (
  <Button
    ref={ref}
    variant={variant}
    controlSize="regular"
    content="iconText"
    className={cn("flex-shrink-0", className)}
    {...props}
  >
    {children}
  </Button>
));

ComposerToolbarButton.displayName = "ComposerToolbarButton";
