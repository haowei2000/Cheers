import type { ComponentType, ReactNode } from "react";
import { HelpLabel } from "./help-text";
import { cn } from "@/lib/cn";

// The canonical empty state (DESIGN.md §2.9): centered icon + primary line +
// optional secondary hint. Compact lists may still use a one-liner
// (`text-caption py-4 text-center`) instead.
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  hint?: ReactNode;
  /** The one step that fills this empty state (create, add, find). */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-8 text-center",
        className
      )}
    >
      {Icon && <Icon className="w-5 h-5 text-content-muted mb-2" />}
      <HelpLabel className="text-caption" help={hint}>{title}</HelpLabel>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
