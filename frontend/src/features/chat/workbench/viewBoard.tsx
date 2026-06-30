// ViewBoard — the second kind of workbench panel.
//
// The File panel is *file-backed*: it browses `context_files` and renders them via
// renderer plugins/lenses, and the user edits them. A ViewBoard is a *data-view*:
// it reads server-derived, read-only data from a resource verb (e.g. channel.plan.read,
// channel.usage.read) and renders it. Plan and Cost are ViewBoards.
//
// This helper owns the shared chrome every ViewBoard needs — the fetch
// (useResourceQuery), the toolbar (title + session-scope badge + refresh), and the
// loading/error states — so each board only declares its verb + params + a render of
// the data. ViewBoards register through the normal panelRegistry (kind: "viewboard"),
// which also makes the drawer render them regardless of an active environment.
import { type ReactNode, useCallback } from "react";
import { RefreshCw, type LucideIcon } from "lucide-react";
import { registerPanel, type PanelContext, type PanelDef } from "./panelRegistry";
import { useResourceQuery } from "./useResourceQuery";

export interface ViewBoardDef<T> {
  id: string;
  title: string;
  icon?: LucideIcon;
  /** The resource verb to read (e.g. "channel.plan.read"). */
  verb: string;
  /** Build the verb params from ctx. Session-scoped boards add session_id here. */
  makeParams: (ctx: PanelContext) => Record<string, unknown>;
  /** When true, show the channel's selected-session scope in the toolbar. The
   *  actual filtering is done by `makeParams` (so this is purely the UI label). */
  sessionScoped?: boolean;
  /** Render the loaded data. Owns both the populated and the empty presentation
   *  (data is non-null once the first response arrives; [] is "loaded but empty"). */
  render: (data: T, ctx: PanelContext) => ReactNode;
}

function sessionLabel(ctx: PanelContext): string {
  // "" / null = Auto/all (the composer's SessionSwitcher default).
  const sid = ctx.selectedSessionId;
  return sid ? `Session ${sid.slice(0, 8)}` : "All sessions";
}

export function defineViewBoard<T>(def: ViewBoardDef<T>): PanelDef {
  function ViewBoard({ ctx }: { ctx: PanelContext }) {
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
            // First load (no data yet) — show a neutral hint, not the board's
            // "empty" state (which means "loaded and there's nothing").
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
    kind: "viewboard",
    render: (ctx) => <ViewBoard ctx={ctx} />,
  };
}

/** Register a ViewBoard as a workbench panel (sugar over registerPanel). */
export function registerViewBoard<T>(def: ViewBoardDef<T>): void {
  registerPanel(defineViewBoard(def));
}

/** Standard params builder for a session-scoped, channel-level board:
 *  `{ channel_id, session_id? }` — session_id only when a session is selected. */
export function channelSessionParams(ctx: PanelContext): Record<string, unknown> {
  return {
    channel_id: ctx.channelId,
    ...(ctx.selectedSessionId ? { session_id: ctx.selectedSessionId } : {}),
  };
}
