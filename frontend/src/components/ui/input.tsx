import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error, className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        // Borderless filled field (DESIGN.md §2.3): the fill is the affordance,
        // rings are states (focus indigo, error red).
        // text-base (16px) below md prevents iOS Safari's auto-zoom on focus.
        "h-9 w-full rounded-lg px-3 text-base md:text-sm bg-zinc-800 text-zinc-100 placeholder-zinc-500 transition-shadow",
        "focus:outline-none focus:ring-2 focus:ring-indigo-500",
        error && "ring-1 ring-red-500/70",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
