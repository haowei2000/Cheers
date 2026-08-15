import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

// At-a-glance summary rows for the minimized instrument panels (ViewBoard,
// Remote workspace, Workbench, Channel files). A minimized panel is a purpose-
// built glance — one row per key signal — NOT the full panel shrunk. Clicking a
// row expands the panel (rows carry `onClick`). Extracted from ViewBoardMinimized
// so every panel's minimized state reads as one system.

export function GlanceRow({
  Icon,
  label,
  value,
  sub,
  bar,
  onClick,
  title,
  children,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  sub?: string | null;
  /** 0–100 progress bar, or null to omit. */
  bar?: number | null;
  onClick?: () => void;
  /** Tooltip; defaults to "Open <label>". */
  title?: string;
  /** Extra glance lines under the main row (per-bot cost, summaries…). */
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? `Open ${label}`}
      className="group flex w-full flex-col gap-1 rounded-sm px-3 py-2 text-left transition-colors hover:bg-zinc-800/60"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 flex-shrink-0 text-content-muted" />
        <span className="flex-1 text-caption">{label}</span>
        {sub && <span className="text-metadata tabular-nums">{sub}</span>}
        <span className="text-status tabular-nums truncate max-w-[55%] text-right">
          {value}
        </span>
        <ChevronRight className="w-3.5 h-3.5 text-content-muted opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      {bar != null && (
        <div data-design-system-exempt="progress" className="ml-[22px] h-1 overflow-hidden rounded-full bg-zinc-800">
          <div data-design-system-exempt="progress" className="h-full rounded-full bg-emerald-500" style={{ width: `${bar}%` }} />
        </div>
      )}
      {children && <div className="ml-[22px] w-[calc(100%-22px)] space-y-1">{children}</div>}
    </button>
  );
}

/** One indented detail line under a glance row (name left, figure right). */
export function DetailLine({ name, figure }: { name: string; figure?: string }) {
  return (
    <div className="flex items-baseline gap-2 text-metadata">
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {figure && <span className="tabular-nums">{figure}</span>}
    </div>
  );
}
