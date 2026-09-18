import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface TypewriterCursorProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

/**
 * Mechanical typewriter block cursor defined in DESIGN.md §1 & §4.
 * Used during agent thinking and active message streaming.
 */
export function TypewriterCursor({ label, className, ...props }: TypewriterCursorProps) {
  return (
    <span
      data-design-system-exempt="progress"
      className={cn(
        "inline-block w-2 h-4 bg-content-strong animate-blink motion-reduce:animate-none align-text-bottom",
        className
      )}
      aria-label={label ?? "Typewriter cursor"}
      role={label ? "status" : undefined}
      {...props}
    />
  );
}
