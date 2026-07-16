import type { ComponentType } from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

// The canonical error state (tier L of the global error system): centered glyph +
// one-line title + one-line explanation + a primary exit action. Mirrors the
// EmptyState skeleton (DESIGN.md §2.9) in error semantics. Use it when the current
// view is unusable (load failed, no access, session expired, crashed) — routine
// operation failures use toast, degraded-but-still-usable states use <Banner>.
export function ErrorState({
  icon: Icon = AlertCircle,
  tone = "error",
  title,
  description,
  action,
  secondaryAction,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  /** error = it broke (red) · warning = needs attention, nothing lost (amber). */
  tone?: "error" | "warning";
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** Quiet text link next to the primary action (e.g. "Copy error details"). */
  secondaryAction?: { label: string; onClick: () => void };
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center py-10 px-6 text-center",
        className
      )}
    >
      <Icon
        className={cn(
          "w-8 h-8 mb-3",
          tone === "error" ? "text-red-400" : "text-amber-400"
        )}
      />
      <p className="text-sm font-semibold text-zinc-100">{title}</p>
      {description && (
        <p className="text-xs text-zinc-400 mt-1 max-w-xs">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="flex items-center gap-3 mt-4">
          {action && (
            <Button size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline transition-colors"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
