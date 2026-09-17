import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { controlHeightClasses, controlSquareClasses, useControlSize, type ControlSize } from "./control-size";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlSize?: ControlSize;
  controlWidth?: "slot" | "fill" | "icon" | "content";
  variant?: "default" | "plain";
}

// Resting unboxed select that reveals outline and background on hover and click/focus.
export const Select = forwardRef<
  HTMLSelectElement,
  SelectProps
>(({ controlSize, controlWidth = "fill", variant = "default", className, children, ...props }, ref) => {
  const size = useControlSize(controlSize);
  return (
  <select
    ref={ref}
    className={cn(
      "text-comfortable md:text-regular text-content-primary transition-all duration-150 cursor-pointer",
      variant === "plain"
        ? "bg-transparent ring-0 border-0 rounded-none px-2 focus:bg-control/40 focus:ring-1 focus:ring-content-strong/40"
        : cn(
            "rounded-sm px-2 bg-transparent ring-1 ring-inset ring-transparent",
            "hover:bg-control/40 hover:ring-zinc-300/80 dark:hover:ring-zinc-700/80 hover:text-content-strong",
            "focus:bg-control/60 focus:ring-1 focus:ring-inset focus:ring-content-strong/50 focus:text-content-strong active:bg-control-active",
          ),
      controlWidth === "fill"
        ? "w-full"
        : controlWidth === "icon"
          ? controlSquareClasses[size]
          : controlWidth === "content"
            ? "w-auto max-w-full"
            : "w-32 max-w-full",
      controlHeightClasses[size],
      "focus:outline-none",
      "disabled:opacity-50 disabled:cursor-not-allowed",
      "[&>option]:bg-panel [&>option]:text-content-primary",
      className
    )}
    {...props}
  >
    {children}
  </select>
  );
});
Select.displayName = "Select";
