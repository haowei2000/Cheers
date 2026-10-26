import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import {
  controlHeightClasses,
  controlSquareClasses,
  controlTextClasses,
  useControlSize,
  type ControlSize,
} from "./control-size";
import { selectedClasses, tabClasses } from "./selection";

/**
 * Non-action trigger for selectors, tabs, disclosures, and navigation. Actions
 * such as Save/Add/Delete must use Button and its ActionKey dictionary.
 */
export interface ControlTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  controlSize?: ControlSize;
  controlWidth?: "slot" | "fill" | "content";
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
    role,
    "aria-expanded": ariaExpanded,
    ...props
  }, ref) => {
    const size = useControlSize(controlSize);
    const isTab = role === "tab";
    return (
      <button
        ref={ref}
        type="button"
        data-control-trigger=""
        data-control-size={size}
        data-selected={selected || undefined}
        role={role}
        aria-expanded={ariaExpanded}
        aria-pressed={isTab || ariaExpanded !== undefined ? undefined : selected || undefined}
        className={cn(
          "inline-flex min-w-0 items-center justify-center gap-1 overflow-hidden font-utility font-medium whitespace-nowrap transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700/60 dark:focus-visible:ring-zinc-300/60 disabled:pointer-events-none disabled:opacity-50",
          controlTextClasses[size],
          square ? controlSquareClasses[size] : controlHeightClasses[size],
          !square && (
            controlWidth === "fill"
              ? "w-full"
              : controlWidth === "content"
                ? "w-auto max-w-full px-2"
                : "w-24 max-w-full px-3"
          ),
          isTab
            ? tabClasses(selected)
            : cn(
                "rounded-sm transition-all duration-150",
                selected
                  ? selectedClasses("ring")
                  : "bg-transparent ring-1 ring-inset ring-transparent text-content-primary hover:bg-control/40 hover:ring-zinc-300/80 dark:hover:ring-zinc-700/80 hover:text-content-strong active:bg-control-active",
              ),
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
