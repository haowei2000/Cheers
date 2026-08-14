import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { controlHeightClasses, controlSquareClasses, useControlSize, type ControlSize } from "./control-size";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlSize?: ControlSize;
  controlWidth?: "slot" | "fill" | "icon";
}

// Filled select with the same accessible inset boundary as Input (DESIGN.md §2.3).
export const Select = forwardRef<
  HTMLSelectElement,
  SelectProps
>(({ controlSize, controlWidth = "fill", className, children, ...props }, ref) => {
  const size = useControlSize(controlSize);
  return (
  <select
    ref={ref}
    className={cn(
      "rounded-sm bg-zinc-800 px-3 text-comfortable md:text-regular text-zinc-100 ring-1 ring-inset ring-zinc-600 transition-shadow",
      controlWidth === "fill" ? "w-full" : controlWidth === "icon" ? controlSquareClasses[size] : "w-32 max-w-full",
      controlHeightClasses[size],
      "focus:outline-none focus:ring-2 focus:ring-indigo-500",
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
