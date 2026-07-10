import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

// Borderless filled select mirroring Input (DESIGN.md §2.3).
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-9 w-full rounded-lg bg-zinc-800 px-3 text-base md:text-sm text-zinc-100 transition-shadow",
      "focus:outline-none focus:ring-2 focus:ring-indigo-500",
      "disabled:opacity-50 disabled:cursor-not-allowed",
      className
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";
