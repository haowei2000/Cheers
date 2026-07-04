// ViewBoard — the channel's instrument / observability plane, SEPARATE from the
// Workbench. The Workbench is a *file-based workspace* (context_files, fs.*, editable,
// rendered via lenses/plugins). A ViewBoard is NOT file-based: it renders a live,
// read-only *projection* of agent activity / session state from a resource verb
// (*.read), keyed by channel + optionally the selected session. Truth lives in the
// event/session/usage stores, not in a file. Maps to the two-class data model:
// Class 2 (agent-edited files) → Workbench; Class 1 (self-maintained state) → ViewBoard.
//
// ViewBoards have their OWN registry and their OWN host (ViewBoardDrawer) — they are
// not workbench panels.
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { RefreshCw, type LucideIcon } from "lucide-react";
import type { SendResourceReq } from "./fsClient";
import { useResourceQuery } from "./useResourceQuery";

/** The minimal context a ViewBoard needs — channel + resource client + the selected
 *  session. No files / pins / plugins (that's the Workbench's PanelContext). */
export interface ViewBoardContext {
  channelId: string;
  sendResourceReq: SendResourceReq;
  /** The composer's selected session ("" / null = Auto / All sessions). */
  selectedSessionId?: string | null;
  /** Live-push: a monotonic per-board counter (board id → tick). When this board's
   *  tick bumps (a board_signal arrived over the WS), the board re-fetches — no
   *  manual refresh. */
  boardTick?: Record<string, number>;
  /** False when the board is kept mounted but hidden (its tab isn't active). Boards
   *  defer tick-driven refetches while hidden and catch up on reveal. */
  visible?: boolean;
}

/** Tick-driven refetch that (a) skips the mount (useResourceQuery / the board's own
 *  initial load already fetched), and (b) defers while hidden, catching up once the
 *  board becomes visible again. Shared by defineViewBoard and self-fetching boards. */
export function useBoardTickRefetch(
  ctx: ViewBoardContext,
  boardId: string,
  refetch: () => void
): void {
  const tick = ctx.boardTick?.[boardId] ?? 0;
  const visible = ctx.visible !== false;
  // Initialize to the mount tick so a signal that arrived before mount doesn't
  // duplicate the initial fetch.
  const lastTick = useRef(tick);
  useEffect(() => {
    if (visible && tick > lastTick.current) {
      lastTick.current = tick;
      refetch();
    }
  }, [tick, visible, refetch]);
}

export interface ViewBoardDef<T> {
  id: string;
  title: string;
  icon?: LucideIcon;
  /** The resource verb to read (e.g. "channel.plan.read"). */
  verb: string;
  /** Build the verb params from ctx. Session-scoped boards add session_id here. */
  makeParams: (ctx: ViewBoardContext) => Record<string, unknown>;
  /** When true, the toolbar shows the channel's selected-session scope. */
  sessionScoped?: boolean;
  /** Render the loaded data (owns both the populated and the empty presentation).
   *  `refetch` lets an actionable board (e.g. Sessions: create/close) refresh itself
   *  after a lightweight control action. */
  render: (data: T, ctx: ViewBoardContext, refetch: () => void) => ReactNode;
}

/** A registered, renderable board (the result of defineViewBoard). */
export interface ViewBoardPanel {
  id: string;
  title: string;
  icon?: LucideIcon;
  /** True when the board's data is per-session — the host shows a session-scope selector. */
  sessionScoped?: boolean;
  render: (ctx: ViewBoardContext) => ReactNode;
}

const registry: ViewBoardPanel[] = [];

export function registerViewBoard<T>(def: ViewBoardDef<T>): void {
  if (!registry.some((b) => b.id === def.id)) registry.push(defineViewBoard(def));
}

/** Register a board that fetches its own data (e.g. a REST endpoint with no resource verb).
 *  The component owns its body; use ViewBoardShell for the standard header/refresh chrome. */
export function registerComponentViewBoard(def: {
  id: string;
  title: string;
  icon?: LucideIcon;
  component: (ctx: ViewBoardContext) => ReactNode;
}): void {
  if (registry.some((b) => b.id === def.id)) return;
  registry.push({
    id: def.id,
    title: def.title,
    icon: def.icon,
    render: (ctx) => def.component(ctx),
  });
}

/** Standard board chrome (header with icon/title/loading/refresh + scrollable body), so
 *  self-fetching component boards match the verb-bound ones. */
export function ViewBoardShell({
  title,
  icon: Icon,
  loading,
  onRefresh,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  loading?: boolean;
  onRefresh?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full text-sm">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
        {Icon && <Icon className="w-3.5 h-3.5 text-zinc-500" />}
        <span className="text-xs text-zinc-300">{title}</span>
        <div className="flex-1" />
        {loading && <span className="text-[10px] text-zinc-600">Loading…</span>}
        {onRefresh && (
          <button onClick={onRefresh} title="Refresh" disabled={loading}>
            <RefreshCw
              className={`w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

export function getViewBoards(): ViewBoardPanel[] {
  return registry;
}

export function defineViewBoard<T>(def: ViewBoardDef<T>): ViewBoardPanel {
  function Board({ ctx }: { ctx: ViewBoardContext }) {
    const { data, loading, error, refetch } = useResourceQuery<T>(
      ctx.sendResourceReq,
      def.verb,
      def.makeParams(ctx),
      !!ctx.channelId
    );
    const onRefresh = useCallback(() => refetch(), [refetch]);
    const Icon = def.icon;

    // Live-push: re-fetch when this board's tick bumps (a board_signal arrived).
    // Deferred while the board is kept-alive but hidden; catches up on reveal.
    useBoardTickRefetch(ctx, def.id, refetch);

    return (
      <div className="flex flex-col h-full text-sm">
        <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
          {Icon && <Icon className="w-3.5 h-3.5 text-zinc-500" />}
          <span className="text-xs text-zinc-300">{def.title}</span>
          <div className="flex-1" />
          {loading && <span className="text-[10px] text-zinc-600">Loading…</span>}
          <button onClick={onRefresh} title="Refresh" disabled={loading}>
            <RefreshCw
              className={`w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {error ? (
            <div className="px-3 py-3 text-xs text-red-400">{error}</div>
          ) : data == null ? (
            // First load (no data yet) — neutral hint, not the board's "empty" state.
            <div className="px-3 py-6 text-xs text-zinc-600">Loading…</div>
          ) : (
            def.render(data, ctx, refetch)
          )}
        </div>
      </div>
    );
  }

  return {
    id: def.id,
    title: def.title,
    icon: def.icon,
    sessionScoped: def.sessionScoped,
    render: (ctx) => <Board ctx={ctx} />,
  };
}

/** Standard params for a session-scoped board: `{ channel_id, session_id? }`. */
export function channelSessionParams(ctx: ViewBoardContext): Record<string, unknown> {
  return {
    channel_id: ctx.channelId,
    ...(ctx.selectedSessionId ? { session_id: ctx.selectedSessionId } : {}),
  };
}
