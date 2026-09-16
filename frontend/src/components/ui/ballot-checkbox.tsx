import type { HTMLAttributes } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

export interface BallotCheckboxProps extends HTMLAttributes<HTMLSpanElement> {
  checked: boolean;
  size?: "regular" | "compact";
}

/**
 * Archival Ballot Box checkbox mark for row selection, item pickers, and rosters.
 * Implements the physical carbon-ink seal / ballot box stamping metaphor.
 */
export function BallotCheckbox({
  checked,
  size = "regular",
  className,
  ...props
}: BallotCheckboxProps) {
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-sm flex-shrink-0 transition-colors",
        size === "compact" ? "w-3.5 h-3.5" : "w-4 h-4",
        checked
          ? "bg-accent-600 ring-1 ring-inset ring-accent-600 text-content-on-accent"
          : "bg-control/40 ring-1 ring-inset ring-zinc-700/60 text-transparent",
        className
      )}
      aria-hidden="true"
      {...props}
    >
      {checked && <Check className={size === "compact" ? "w-3 h-3" : "w-3.5 h-3.5"} />}
    </span>
  );
}
