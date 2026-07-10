// ViewBoardDrawer — host for the channel's ViewBoards (the instrument plane),
// SEPARATE from the file-based Workbench. Rendered as a floating, rounded card anchored
// to the TOP-RIGHT (Codex "Environment" popover style) rather than a full-height edge
// drawer, so it reads as a lightweight instrument overlay. Non-modal (no backdrop) so it
// can stay open alongside the Workbench; both are draggable (useWindowDrag), so
// overlapping windows are resolved by the user, and a click brings a window to the front.
import { useEffect, useMemo, useState } from "react";
import { LayoutDashboard, X, Minimize2, Maximize2, Layers } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import { ResizeGrip } from "@/components/ui/resize-grip";
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
  /** Default-position nicety: while the ViewBoard has never been dragged, float it
   *  to the LEFT of the (also right-anchored) Workbench so both show. A dragged
   *  position always wins. */
  shiftedForWorkbench?: boolean;
  /** Minimal mode: a compact content-height card in a narrower column (vs the full
   *  full-height column). Still keeps its own column; toggled from the header. */
  minimal?: boolean;
  onToggleMinimal?: () => void;
  /** Best-effort "jump the chat to this message" (scroll + flash when loaded). */
  onJumpToMessage?: (msgId: string) => void;
}

const WORKBENCH_WIDTH = 560; // keep in sync with WorkbenchDrawer's w-[560px]
const EDGE_GAP = 12; // inset from the right edge (default, pre-drag position)
const ACTIVE_BOARD_KEY = "cheers.viewboard.active"; // last-viewed board, restored on reload

interface SessionOpt {
  session_id: string;
  bot_id: string;
  bot_name?: string | null;
  is_primary: boolean;
  cwd?: string | null;
  created_at?: string | null;
}

export function ViewBoardDrawer({
  open,
  onClose,
  channelId,
  sendResourceReq,
  boardTick,
  shiftedForWorkbench,
  minimal,
  onToggleMinimal,
  onJumpToMessage,
}: Props) {
  const boards = getViewBoards();
  const [active, setActive] = useState<string>(
    () => localStorage.getItem(ACTIVE_BOARD_KEY) ?? ""
  );
  const activeBoard = boards.find((b) => b.id === active) ?? boards[0];
  useEffect(() => {
    if (active) localStorage.setItem(ACTIVE_BOARD_KEY, active);
  }, [active]);

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

  // Mobile: the card spans the full width (left/right insets via classes below);
  // dragging is desktop-only.
  const isMobile = useIsMobile();
  const windowDrag = useWindowDrag("cheers.float.viewboard", !isMobile);

  return (
    // Rounded, elevated FLOATING instrument card (Codex-style chrome), draggable by
    // its title bar — it floats over the chat without reserving a column, so the
    // composer keeps its full width. Expanded = a full-height 420 window with the
    // full boards; minimal = a compact content-height 280 glance card
    // (ViewBoardMinimized). Slides off to the right when closed.
    <aside
      ref={windowDrag.ref}
      onPointerDownCapture={windowDrag.toFront}
      className={`fixed top-14 flex max-w-[94vw] flex-col overflow-hidden rounded-xl bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur-sm transition-[opacity,transform] duration-200 max-md:left-2 max-md:w-auto max-md:max-w-none ${
        minimal
          ? "w-[280px] max-h-[calc(100dvh-4.5rem)]"
          : // Desktop default height stops ~6rem short of the bottom so the window
            // never sits on the composer line; mobile keeps the bottom anchor.
            "w-[420px] h-[calc(100dvh-9.5rem)] max-md:h-auto max-md:bottom-[max(0.5rem,env(safe-area-inset-bottom))]"
      } ${
        open
          ? "opacity-100 translate-x-0 pointer-events-auto"
          : "opacity-0 translate-x-4 pointer-events-none"
      }`}
      style={
        // Minimal ignores any resized size (posStyle) — it is a fixed compact
        // glance card. Expanded uses the full geometry; when dragged but NOT
        // resized, size the window explicitly from its new top edge (the
        // bottom anchor is overridden by bottom: auto).
        windowDrag.pos
          ? minimal
            ? { ...windowDrag.posStyle, maxHeight: `calc(100dvh - ${windowDrag.pos.y + 12}px)` }
            : {
                ...windowDrag.style,
                ...(windowDrag.size ? {} : { height: `calc(100dvh - ${windowDrag.pos.y + 12}px)` }),
              }
          : {
              ...(minimal ? windowDrag.posStyle : windowDrag.style),
              right:
                !isMobile && shiftedForWorkbench && open
                  ? WORKBENCH_WIDTH + EDGE_GAP * 2
                  : EDGE_GAP,
            }
      }
    >
      <div
        {...windowDrag.handleProps}
        className="flex items-center gap-2 px-3 h-10 border-b border-zinc-800 flex-shrink-0 select-none"
      >
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
        <div className="flex-1 min-h-0 overflow-auto">
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
                      : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
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
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Scope</span>
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
      {/* Resizable in expanded mode; minimal stays a fixed compact glance card. */}
      {!minimal && <ResizeGrip resizeProps={windowDrag.resizeProps} />}
    </aside>
  );
}
