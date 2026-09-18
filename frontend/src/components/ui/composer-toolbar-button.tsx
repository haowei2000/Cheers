import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

type ComposerToolbarButtonProps = ComponentPropsWithoutRef<typeof Button>;

/**
 * Composer selectors use the shared regular icon+text slot. Their visible
 * labels must be short; the full current value belongs in the accessible name
 * and tooltip instead of being truncated inside the control.
 *
 * Resting unboxed control: transparent background and ring at rest, revealing
 * outline on hover and active/selected styling when open or chosen.
 */
export const ComposerToolbarButton = forwardRef<
  HTMLButtonElement,
  ComposerToolbarButtonProps
>(({ className, variant = "plain", selected, children, ...props }, ref) => (
  <Button
    ref={ref}
    variant={variant}
    controlSize="regular"
    content="iconText"
    selected={selected}
    className={cn(
      "flex-shrink-0 transition-all duration-150 ring-1 ring-inset",
      selected
        ? "bg-selected text-content-strong font-semibold ring-selected-indicator/70 hover:bg-selected-hover hover:text-content-strong active:bg-selected-active shadow-sm"
        : "bg-transparent ring-transparent text-content-primary hover:bg-control/40 hover:ring-zinc-300/80 dark:hover:ring-zinc-700/80 hover:text-content-strong active:bg-control-active",
      className,
    )}
    {...props}
  >
    {children}
  </Button>
));

ComposerToolbarButton.displayName = "ComposerToolbarButton";
