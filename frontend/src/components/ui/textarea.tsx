import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

// Borderless filled textarea mirroring Input (DESIGN.md §2.3).
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error, className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-lg bg-zinc-800 px-3 py-2 text-base md:text-sm text-zinc-100 placeholder-zinc-500 transition-shadow",
        "focus:outline-none focus:ring-2 focus:ring-indigo-500",
        error && "ring-1 ring-red-500/70",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";
