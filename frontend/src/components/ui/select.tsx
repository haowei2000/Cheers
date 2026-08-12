import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { controlHeightClasses, useControlSize, type ControlSize } from "./control-size";

// Borderless filled select mirroring Input (DESIGN.md §2.3).
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { controlSize?: ControlSize }
>(({ controlSize, className, children, ...props }, ref) => {
  const size = useControlSize(controlSize);
  return (
  <select
    ref={ref}
    className={cn(
      "w-full rounded-sm bg-zinc-800 px-3 text-comfortable md:text-regular text-zinc-100 transition-shadow",
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
