import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface SeparatorProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  /** A rule that only groups visually is noise to a screen reader. Leave this
   *  true unless the rule carries real meaning, e.g. a date break in a log. */
  decorative?: boolean;
}

/**
 * A hairline rule. Grouping is spacing's job first — reach for this only where
 * a register has to scan as a table, or an editorial section genuinely breaks.
 * Resting controls stay free of layout-affecting borders, so this draws with a
 * background rather than a border and never shifts what sits around it.
 */
export const Separator = forwardRef<HTMLDivElement, SeparatorProps>(
  ({ orientation = "horizontal", decorative = true, className, ...props }, ref) => (
    <div
      ref={ref}
      role={decorative ? "presentation" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      aria-hidden={decorative || undefined}
      className={cn(
        "flex-shrink-0 bg-zinc-800",
        orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
        className
      )}
      {...props}
    />
  )
);
Separator.displayName = "Separator";
