import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { controlHeightClasses, controlSquareClasses, useControlSize, type ControlSize } from "./control-size";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlSize?: ControlSize;
  controlWidth?: "slot" | "fill" | "icon";
  variant?: "default" | "plain";
}

// Filled select with the same accessible inset boundary as Input (DESIGN.md §2.3).
export const Select = forwardRef<
  HTMLSelectElement,
  SelectProps
>(({ controlSize, controlWidth = "fill", variant = "default", className, children, ...props }, ref) => {
  const size = useControlSize(controlSize);
  return (
  <select
    ref={ref}
    className={cn(
      "text-comfortable md:text-regular text-content-primary transition-shadow",
      variant === "plain"
        ? "bg-transparent ring-0 border-0 rounded-none px-2 focus:bg-control/40 focus:ring-1 focus:ring-content-strong/40"
        : "rounded-sm bg-control/60 px-3 ring-1 ring-inset ring-zinc-700/60 focus:ring-1 focus:ring-content-strong/50",
      controlWidth === "fill" ? "w-full" : controlWidth === "icon" ? controlSquareClasses[size] : "w-32 max-w-full",
      controlHeightClasses[size],
      "focus:outline-none",
      "disabled:opacity-50 disabled:cursor-not-allowed",
      className
    )}
    {...props}
  >
    {children}
  </select>
  );
});
Select.displayName = "Select";
