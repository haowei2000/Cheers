import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/cn";

// The canonical empty state (DESIGN.md §2.9): centered icon + primary line +
// optional secondary hint. Compact lists may still use a one-liner
// (`text-compact text-zinc-400 py-4 text-center`) instead.
export function EmptyState({
  icon: Icon,
  title,
  hint,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-8 text-center",
        className
      )}
    >
      {Icon && <Icon className="w-5 h-5 text-zinc-400 mb-2" />}
      <p className="text-compact text-zinc-400">{title}</p>
      {hint && <p className="text-compact text-zinc-400 mt-1">{hint}</p>}
    </div>
  );
}
