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
      className="group flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-zinc-800/60"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 flex-shrink-0 text-zinc-500" />
        <span className="flex-1 text-xs text-zinc-400">{label}</span>
        {sub && <span className="text-[10px] tabular-nums text-zinc-400">{sub}</span>}
        <span className="text-xs font-medium tabular-nums text-zinc-100 truncate max-w-[55%] text-right">
          {value}
        </span>
        <ChevronRight className="w-3 h-3 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      {bar != null && (
        <div className="ml-[22px] h-1 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${bar}%` }} />
        </div>
      )}
      {children && <div className="ml-[22px] w-[calc(100%-22px)] space-y-0.5">{children}</div>}
    </button>
  );
}

/** One indented detail line under a glance row (name left, figure right). */
export function DetailLine({ name, figure }: { name: string; figure?: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[10px]">
      <span className="min-w-0 flex-1 truncate text-zinc-400">{name}</span>
      {figure && <span className="tabular-nums text-zinc-400">{figure}</span>}
    </div>
  );
}
