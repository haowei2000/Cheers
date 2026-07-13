// ViewBoardDrawer — host for the channel's ViewBoards (the instrument plane),
// SEPARATE from the file-based Workbench. On desktop it DOCKS into the channel's
// work area (a real layout column on the right, beside the Workbench and the
// Remote workspace) so it never covers the chat — the chat column narrows and
// docks against it instead. On mobile it stays a near-full-screen overlay sheet.
import { memo, useEffect, useMemo, useState } from "react";
import { LayoutDashboard, X, Minimize2, Maximize2, Layers } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLaneWindow } from "@/hooks/useLaneWindow";
import { cn } from "@/lib/cn";
import { sessionTag } from "@/features/chat/sessionLabel";
import type { SendResourceReq } from "./fsClient";
import { getViewBoards, type ViewBoardContext } from "./viewBoard";
import { ViewBoardMinimized } from "./ViewBoardMinimized";
// Built-in boards register themselves on import (side effect).
import "./panels/PlanBoardPanel";
import "./panels/CostPanel";
import "./panels/SessionsPanel";
import "./panels/AuditPanel";
import "./panels/ActivityPanel";

interface Props {
  open: boolean;
  onClose: () => void;
  channelId: string;
  sendResourceReq: SendResourceReq;
  /** Composer's selected session — accepted for API compatibility; the ViewBoard now
   *  drives its own session scope (defaults to "All sessions") so you can compare many. */
  selectedSessionId?: string | null;
  /** Live-push ticks (board id → counter) from the WS board_signal stream. */
  boardTick?: Record<string, number>;
  /** Minimal mode: a compact glance list in a narrower dock column (vs the full
   *  boards in the regular column). Toggled from the header. */
  minimal?: boolean;
  onToggleMinimal?: () => void;
  /** Best-effort "jump the chat to this message" (scroll + flash when loaded). */
  onJumpToMessage?: (msgId: string) => void;
  /** External "switch to this board" request (composer's "Manage sessions…").
   *  `nonce` lets a repeat request for the same board re-apply. */
  focusBoard?: { id: string; nonce: number };
}

const ACTIVE_BOARD_KEY = "cheers.viewboard.active"; // last-viewed board, restored on reload

interface SessionOpt {
  session_id: string;
  bot_id: string;
  bot_name?: string | null;
  is_primary: boolean;
  cwd?: string | null;
  created_at?: string | null;
}

function ViewBoardDrawerImpl({
  open,
  onClose,
  channelId,
  sendResourceReq,
  boardTick,
  minimal,
  onToggleMinimal,
  onJumpToMessage,
  focusBoard,
}: Props) {
  const boards = getViewBoards();
  const [active, setActive] = useState<string>(
    () => localStorage.getItem(ACTIVE_BOARD_KEY) ?? ""
  );
  const activeBoard = boards.find((b) => b.id === active) ?? boards[0];
  useEffect(() => {
    if (active) localStorage.setItem(ACTIVE_BOARD_KEY, active);
  }, [active]);

  // External board-switch request (e.g. the composer's "Manage sessions…").
  useEffect(() => {
    if (focusBoard) setActive(focusBoard.id);
  }, [focusBoard]);

  // Keep-alive: boards visited this channel stay mounted (hidden) so tab switches
  // don't remount → refetch → lose scroll/filter state. Reset on channel change so
  // a switch doesn't fan out one fetch per previously-visited board.
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setVisited(new Set()), [channelId]);
  const activeId = activeBoard?.id;
  useEffect(() => {
    if (!activeId) return;
    setVisited((v) => (v.has(activeId) ? v : new Set(v).add(activeId)));
  }, [activeId]);

  // The ViewBoard's OWN session scope ("" = All sessions), independent of the composer's
  // send target, so Plan / Cost can show many sessions at once or focus on one.
  const [scope, setScope] = useState<string>("");
  const [sessions, setSessions] = useState<SessionOpt[]>([]);

  // Reset the scope when the channel changes (its session set is different).
  useEffect(() => setScope(""), [channelId]);

  // Populate the scope selector from the channel's live sessions (best-effort; on failure
  // the selector just offers "All sessions"). Refetched when the sessions tick bumps.
  // Skipped in minimal mode — the selector isn't rendered there.
  const sessionsTick = boardTick?.sessions ?? 0;
  useEffect(() => {
    if (!open || minimal || !channelId) return;
    let alive = true;
    (async () => {
      try {
        const res = (await sendResourceReq("channel.sessions.read", {
          channel_id: channelId,
        })) as {
          sessions?: Array<{
            session_id: string;
            bot_id: string;
            bot_name?: string | null;
            is_primary: boolean;
            created_at?: string | null;
            workspace?: { cwd?: string | null };
          }>;
        };
        if (alive) {
          setSessions(
            (res.sessions ?? []).map((s) => ({
              session_id: s.session_id,
              bot_id: s.bot_id,
              bot_name: s.bot_name ?? null,
              is_primary: s.is_primary,
              cwd: s.workspace?.cwd ?? null,
              created_at: s.created_at ?? null,
            }))
          );
        }
      } catch {
        /* selector falls back to "All sessions" only */
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, minimal, channelId, sendResourceReq, sessionsTick]);

  const ctx: ViewBoardContext = useMemo(
    () => ({
      channelId,
      sendResourceReq,
      selectedSessionId: scope || null,
      boardTick,
      onJumpToMessage,
    }),
    [channelId, sendResourceReq, scope, boardTick, onJumpToMessage]
  );

  const isMobile = useIsMobile();
  // Desktop: a tile in the work-lane auto-grid. The card chrome is UNCHANGED; the
  // grid sizes and positions it (fills its cell), so there's no free drag/resize.
  // Minimal collapses to a compact content-height glance card that sits at the
  // top of its cell. Closed keeps it mounted (hidden) so board state survives —
  // and a hidden card drops out of the grid. Mobile keeps the overlay-sheet.
  useLaneWindow();

  // NB: no `flex` here — the desktop shell toggles display via `open ? "flex" :
  // "hidden"`, and `cn` runs tailwind-merge: a hardcoded `flex` in this chrome
  // would win the display conflict over `hidden`, so a CLOSED ViewBoard would
  // still render as a static w-full block. With the lane's `display:contents`
  // (nothing open) that block becomes a flex sibling of the chat column and
  // crushes it to 0 width. WorkbenchDrawer omits `flex` for the same reason.
  const cardChrome =
    "min-h-0 flex-col overflow-hidden rounded-xl bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur-sm";
  const shellClass = isMobile
    ? // z-40: above the chat chrome (z-30 header, z-10/z-20 composer popups,
      // sticky DiffView headers) but below true modals (z-50).
      `fixed top-14 left-2 right-3 z-40 flex flex-col overflow-hidden rounded-xl bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur-sm transition-[opacity,transform] duration-200 ${
        minimal
          ? "max-h-[calc(100dvh-4.5rem)]"
          : "bottom-[max(0.5rem,env(safe-area-inset-bottom))]"
      } ${
        open
          ? "opacity-100 translate-x-0 pointer-events-auto"
          : "opacity-0 translate-x-4 pointer-events-none"
      }`
    : // Desktop grid cell: fill the cell; minimal shrinks to content height and
      // parks at the top of the cell instead of stretching full-height.
      cn(
        open ? "flex" : "hidden",
        cardChrome,
        "w-full",
        minimal ? "h-auto self-start max-h-full" : "h-full"
      );

  return (
    <aside className={shellClass}>
      <div className="flex items-center gap-2 px-3 h-10 border-b border-zinc-800 flex-shrink-0 select-none">
        <LayoutDashboard className="w-4 h-4 text-zinc-400" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          ViewBoard
        </span>
        <div className="flex-1" />
        {onToggleMinimal && (
          <button
            onClick={onToggleMinimal}
            title={minimal ? "Expand" : "Minimize"}
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            {minimal ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
        )}
        <button
          onClick={onClose}
          title="Close"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {minimal ? (
        // Minimized: a purpose-built glance (not the board shrunk). Clicking a row
        // expands straight to that board.
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {open && (
            <ViewBoardMinimized
              ctx={ctx}
              onExpand={(id) => {
                setActive(id);
                onToggleMinimal?.();
              }}
            />
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-800 flex-shrink-0 overflow-x-auto">
            {boards.map((b) => {
              const isActive = activeBoard?.id === b.id;
              const Icon = b.icon;
              return (
                <button
                  key={b.id}
                  onClick={() => setActive(b.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors ${
                    isActive
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                  }`}
                >
                  {Icon && <Icon className="w-3.5 h-3.5" />}
                  {b.title}
                </button>
              );
            })}
          </div>

          {activeBoard?.sessionScoped && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 flex-shrink-0">
              <Layers className="w-3 h-3 text-zinc-500 flex-shrink-0" />
              <span className="text-[10px] uppercase tracking-wide text-zinc-400">Scope</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="min-w-0 flex-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">All sessions</option>
                {sessions.map((s) => (
                  <option
                    key={s.session_id}
                    value={s.session_id}
                    title={`bot ${s.bot_id} · session ${s.session_id}`}
                  >
                    {s.bot_name || s.bot_id.slice(0, 8)} ·{" "}
                    {sessionTag({
                      is_primary: s.is_primary,
                      session_id: s.session_id,
                      cwd: s.cwd,
                      when: s.created_at,
                    })}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Keep visited boards mounted (hidden) so tab switches restore instantly;
              hidden boards defer tick refetches until re-shown (ctx.visible). */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {open &&
              boards
                .filter((b) => visited.has(b.id) || b.id === activeBoard?.id)
                .map((b) => {
                  const isActive = b.id === activeBoard?.id;
                  return (
                    <div key={b.id} className={isActive ? "h-full" : "hidden"}>
                      {b.render({ ...ctx, visible: isActive })}
                    </div>
                  );
                })}
          </div>
        </>
      )}
    </aside>
  );
}

// Memoized: ChannelView re-renders on every streaming delta, but the drawer's props
// (stable callbacks + scalar ids + boardTick) only change on board signals, so this
// skips the whole board subtree during pure token streaming.
export const ViewBoardDrawer = memo(ViewBoardDrawerImpl);
