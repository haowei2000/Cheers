import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

type ComposerToolbarButtonProps = ComponentPropsWithoutRef<typeof Button>;

/**
 * Text-bearing controls in the composer toolbar share one regular control
 * slot. Labels truncate inside the slot instead of changing the toolbar's
 * visual rhythm according to their content length.
 */
export const ComposerToolbarButton = forwardRef<
  HTMLButtonElement,
  ComposerToolbarButtonProps
>(({ className, variant = "plain", children, ...props }, ref) => (
  <Button
    ref={ref}
    variant={variant}
    controlSize="regular"
    className={cn("min-w-0", className)}
    {...props}
  >
    {children}
  </Button>
));

ComposerToolbarButton.displayName = "ComposerToolbarButton";
