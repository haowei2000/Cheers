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
import { type ReactNode, useCallback } from "react";
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
  /** Render the loaded data (owns both the populated and the empty presentation). */
  render: (data: T, ctx: ViewBoardContext) => ReactNode;
}

/** A registered, renderable board (the result of defineViewBoard). */
export interface ViewBoardPanel {
  id: string;
  title: string;
  icon?: LucideIcon;
  render: (ctx: ViewBoardContext) => ReactNode;
}

const registry: ViewBoardPanel[] = [];

export function registerViewBoard<T>(def: ViewBoardDef<T>): void {
  if (!registry.some((b) => b.id === def.id)) registry.push(defineViewBoard(def));
}

export function getViewBoards(): ViewBoardPanel[] {
  return registry;
}

function sessionLabel(ctx: ViewBoardContext): string {
  const sid = ctx.selectedSessionId;
  return sid ? `Session ${sid.slice(0, 8)}` : "All sessions";
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

    return (
      <div className="flex flex-col h-full text-sm">
        <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
          {Icon && <Icon className="w-3.5 h-3.5 text-zinc-500" />}
          <span className="text-xs text-zinc-300">{def.title}</span>
          {def.sessionScoped && (
            <span className="text-[10px] text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-800/60 whitespace-nowrap">
              {sessionLabel(ctx)}
            </span>
          )}
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
            def.render(data, ctx)
          )}
        </div>
      </div>
    );
  }

  return {
    id: def.id,
    title: def.title,
    icon: def.icon,
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
