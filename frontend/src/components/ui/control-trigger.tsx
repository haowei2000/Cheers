import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import {
  controlHeightClasses,
  controlSquareClasses,
  useControlSize,
  type ControlSize,
} from "./control-size";

/**
 * Non-action trigger for selectors, tabs, disclosures, and navigation. Actions
 * such as Save/Add/Delete must use Button and its ActionKey dictionary.
 */
export interface ControlTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  controlSize?: ControlSize;
  controlWidth?: "slot" | "fill";
  square?: boolean;
  /** Open/selected state for selectors and disclosure controls. */
  selected?: boolean;
}

export const ControlTrigger = forwardRef<HTMLButtonElement, ControlTriggerProps>(
  ({
    controlSize,
    controlWidth = "slot",
    square = false,
    selected = false,
    className,
    children,
    "aria-expanded": ariaExpanded,
    ...props
  }, ref) => {
    const size = useControlSize(controlSize);
    return (
      <button
        ref={ref}
        type="button"
        data-control-trigger=""
        data-control-size={size}
        data-selected={selected || undefined}
        aria-expanded={ariaExpanded}
        aria-pressed={ariaExpanded === undefined ? selected || undefined : undefined}
        className={cn(
          "inline-flex min-w-0 items-center justify-center gap-2 overflow-hidden rounded-sm font-utility text-regular font-medium whitespace-nowrap transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-50",
          square ? controlSquareClasses[size] : controlHeightClasses[size],
          !square && (controlWidth === "fill" ? "w-full" : "w-24 max-w-full px-3"),
          selected && "bg-zinc-800 text-content-primary hover:bg-zinc-700 hover:text-content-strong",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
ControlTrigger.displayName = "ControlTrigger";
