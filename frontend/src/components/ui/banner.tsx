import type { ComponentType, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { IconButton } from "./icon-button";

type Severity = "error" | "warning" | "info" | "success";

// Soft fills per DESIGN.md §1 color semantics — the banner is a tinted strip in
// the document flow, never an overlay.
const severityCls: Record<Severity, string> = {
  error: "bg-red-950/45 text-danger-300",
  warning: "bg-amber-900/40 text-warning-200",
  info: "bg-indigo-600/15 text-accent-200",
  success: "bg-emerald-500/10 text-success-400",
};

// The action chip sits ON the tinted fill, so it's one step stronger than the
// §2.1 soft-button recipes (which assume a zinc surface underneath).
const actionCls: Record<Severity, string> = {
  error: "bg-red-900/60 text-danger-100 hover:bg-red-900/90",
  warning: "bg-amber-900/70 text-warning-100 hover:bg-amber-900",
  info: "bg-indigo-600/25 text-accent-100 hover:bg-indigo-600/40",
  success: "bg-emerald-900/60 text-success-100 hover:bg-emerald-900/90",
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
        "flex items-center gap-3 rounded-sm px-3 py-2 text-regular",
        severityCls[severity],
        className
      )}
    >
      {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
      <div className="flex-1 min-w-0">{children}</div>
      {action && (
        <Button
          variant="ghost"
          controlSize="compact"
          onClick={action.onClick}
          className={cn(
            "flex-shrink-0 px-3 font-semibold",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
            actionCls[severity]
          )}
        >
          {action.label}
        </Button>
      )}
      {onDismiss && (
        <IconButton
          onClick={onDismiss}
          label="Dismiss"
          controlSize="compact"
          className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
        >
          <X className="w-4 h-4" />
        </IconButton>
      )}
    </div>
  );
}
