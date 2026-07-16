import type { ComponentType, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

type Severity = "error" | "warning" | "info" | "success";

// Soft fills per DESIGN.md §1 color semantics — the banner is a tinted strip in
// the document flow, never an overlay.
const severityCls: Record<Severity, string> = {
  error: "bg-red-950/45 text-red-300",
  warning: "bg-amber-900/40 text-amber-200",
  info: "bg-indigo-600/15 text-indigo-200",
  success: "bg-emerald-500/10 text-emerald-400",
};

// The action chip sits ON the tinted fill, so it's one step stronger than the
// §2.1 soft-button recipes (which assume a zinc surface underneath).
const actionCls: Record<Severity, string> = {
  error: "bg-red-900/60 text-red-100 hover:bg-red-900/90",
  warning: "bg-amber-900/70 text-amber-100 hover:bg-amber-900",
  info: "bg-indigo-600/25 text-indigo-100 hover:bg-indigo-600/40",
  success: "bg-emerald-900/60 text-emerald-100 hover:bg-emerald-900/90",
};

// Tier M of the global error system: a persistent status strip pinned to the top
// of the affected region (chat area, dialog form, settings section). A banner
// reflects an ongoing STATE, not an event — mount it while the state holds and
// unmount when it clears; one-off failures belong in a toast instead. Ongoing
// states ("reconnecting…") should omit `onDismiss` and clear themselves.
export function Banner({
  severity,
  icon: Icon,
  action,
  onDismiss,
  className,
  children,
}: {
  severity: Severity;
  icon?: ComponentType<{ className?: string }>;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={severity === "error" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm",
        severityCls[severity],
        className
      )}
    >
      {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
      <div className="flex-1 min-w-0">{children}</div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={cn(
            "flex-shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
            actionCls[severity]
          )}
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex-shrink-0 p-0.5 rounded opacity-60 hover:opacity-100 transition-opacity"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
