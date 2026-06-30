// ViewBoardDrawer — host for the channel's ViewBoards (the instrument plane),
// SEPARATE from the file-based Workbench. Its own right-side drawer + its own header
// toggle in ChannelView. Non-modal (no dimming backdrop) so it can be open at the
// same time as the Workbench: when both are open it docks to the LEFT of the
// Workbench (shiftedForWorkbench) so neither overlaps.
import { useMemo, useState } from "react";
import { LayoutDashboard, X } from "lucide-react";
import type { SendResourceReq } from "./fsClient";
import { getViewBoards, type ViewBoardContext } from "./viewBoard";
// Built-in boards register themselves on import (side effect).
import "./panels/PlanBoardPanel";
import "./panels/CostPanel";
import "./panels/SessionsPanel";
import "./panels/ActivityPanel";

interface Props {
  open: boolean;
  onClose: () => void;
  channelId: string;
  sendResourceReq: SendResourceReq;
  /** Composer's selected session ("" = Auto/all) — session-scoped boards filter to it. */
  selectedSessionId?: string | null;
  /** Live-push ticks (board id → counter) from the WS board_signal stream. */
  boardTick?: Record<string, number>;
  /** When the Workbench drawer is also open, dock to its left so both show. */
  shiftedForWorkbench?: boolean;
}

const WORKBENCH_WIDTH = 560; // keep in sync with WorkbenchDrawer's w-[560px]

export function ViewBoardDrawer({
  open,
  onClose,
  channelId,
  sendResourceReq,
  selectedSessionId,
  boardTick,
  shiftedForWorkbench,
}: Props) {
  const boards = getViewBoards();
  const [active, setActive] = useState<string>("");
  const activeBoard = boards.find((b) => b.id === active) ?? boards[0];

  const ctx: ViewBoardContext = useMemo(
    () => ({
      channelId,
      sendResourceReq,
      selectedSessionId: selectedSessionId ?? null,
      boardTick,
    }),
    [channelId, sendResourceReq, selectedSessionId, boardTick]
  );

  return (
    // Non-modal docked panel below the header (top-12), like the Workbench. When the
    // Workbench is also open, dock to its left (right: 560px) so both show side by side.
    <aside
      className={`fixed top-12 h-[calc(100vh-3rem)] w-[460px] max-w-[94vw] bg-zinc-900 border-l border-zinc-800 z-40 flex flex-col transition-transform duration-200 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
      style={{ right: shiftedForWorkbench && open ? `${WORKBENCH_WIDTH}px` : "0" }}
    >
      <div className="flex items-center gap-2 px-3 h-12 border-b border-zinc-800 flex-shrink-0">
        <LayoutDashboard className="w-4 h-4 text-zinc-400" />
        <span className="text-sm font-semibold text-zinc-100">ViewBoard</span>
        <div className="flex-1" />
        <button onClick={onClose} title="Close" className="text-zinc-500 hover:text-zinc-200">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex items-center gap-1 px-2 h-8 border-b border-zinc-800 flex-shrink-0 overflow-x-auto">
        {boards.map((b) => (
          <button
            key={b.id}
            onClick={() => setActive(b.id)}
            className={`px-2 py-0.5 rounded text-xs whitespace-nowrap ${
              activeBoard?.id === b.id
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {b.title}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">{open && activeBoard?.render(ctx)}</div>
    </aside>
  );
}
