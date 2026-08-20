import { Button as UiButton } from "@/components/ui/button";
// The verb-bound panel factory. A resource panel renders a live, read-only PROJECTION
// of platform state read from a resource verb (`*.read`), keyed by channel and
// optionally the host's session scope. Truth lives in the event/session/usage stores,
// not in a file — which is what distinguishes it from an fs-source panel, and why it
// never offers a Save: a projection carries no version to write back against.
//
// Moved here from workbench/viewBoard.tsx unchanged in behavior; see
// docs/arch/PANEL_MODEL.md for why boards stopped being their own subsystem.
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { RefreshCw, type LucideIcon } from "lucide-react";
import { useResourceQuery } from "@/features/chat/workbench/useResourceQuery";
import { registerPanel, type PanelContext, type PanelContribution } from "./registry";

// Trailing-coalesce window for tick-driven refetches. A user↔bot exchange or a
// board_signal burst bumps the tick several times in quick succession; without this
// each bump fired a full refetch (e.g. the Activity panel pulls 200 events + the
// member list). We fire the first bump immediately (zero latency for a lone message)
// then swallow further bumps into one trailing refetch per window.
const PANEL_REFETCH_DEBOUNCE_MS = 500;

/** Tick-driven refetch that (a) skips the mount (useResourceQuery / the panel's own
 *  initial load already fetched), (b) defers while hidden, catching up once the panel
 *  becomes visible again, and (c) coalesces bursts of ticks into at most one refetch
 *  per ~500ms window. Shared by defineResourcePanel and self-fetching panels. */
export function usePanelTickRefetch(
  ctx: PanelContext,
  panelId: string,
  refetch: () => void
): void {
  const tick = ctx.tick?.[panelId] ?? 0;
  const visible = ctx.visible !== false;
  // Initialize to the mount tick so a signal that arrived before mount doesn't
  // duplicate the initial fetch.
  const lastTick = useRef(tick);
  // Newest observed tick + latest refetch identity, read at flush time so a coalesced
  // flush always targets the current scope/params rather than a stale closure.
  const latestTick = useRef(tick);
  latestTick.current = tick;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunAt = useRef(0);

  useEffect(() => {
    if (!visible) {
      // Went hidden: drop any pending flush WITHOUT advancing lastTick, so the panel
      // catches up exactly once when it's revealed again.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (tick <= lastTick.current) return;
    // A flush is already scheduled — it will pick up the newest tick when it fires.
    if (timerRef.current !== null) return;

    const run = () => {
      timerRef.current = null;
      lastTick.current = latestTick.current;
      lastRunAt.current = Date.now();
      refetchRef.current();
    };
    const sinceLast = Date.now() - lastRunAt.current;
    if (sinceLast >= PANEL_REFETCH_DEBOUNCE_MS) {
      run(); // idle long enough — refetch immediately, no added latency
    } else {
      timerRef.current = setTimeout(run, PANEL_REFETCH_DEBOUNCE_MS - sinceLast);
    }
  }, [tick, visible]);

  // Cancel any pending flush on unmount.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );
}

export interface ResourcePanelDef<T> {
  id: string;
  title: string;
  icon?: LucideIcon;
  profiles?: string[];
  /** The resource verb to read (e.g. "channel.plan.read"). */
  verb: string;
  /** Build the verb params from ctx. Session-scoped panels add session_id here. */
  makeParams: (ctx: PanelContext) => Record<string, unknown>;
  /** When "session", the host shows its session-scope selector. */
  scope?: "channel" | "session";
  /** Render the loaded data (owns both the populated and the empty presentation).
   *  `refetch` lets an actionable panel (e.g. Sessions: create/close) refresh itself
   *  after a lightweight control action. */
  render: (data: T, ctx: PanelContext, refetch: () => void) => ReactNode;
}

/** Standard panel chrome (header with icon/title/loading/refresh + scrollable body), so
 *  self-fetching panels match the verb-bound ones. */
export function PanelShell({
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
    <div className="flex flex-col h-full text-regular">
      <div className="mx-3 mt-1 flex h-9 flex-shrink-0 items-center gap-2 border-b border-zinc-800 px-1">
        {Icon && <Icon className="w-3.5 h-3.5 text-content-muted" />}
        <span className="text-compact text-content-secondary">{title}</span>
        <div className="flex-1" />
        {loading && <span className="text-minimal text-content-muted">Loading…</span>}
        {onRefresh && (
          // `action` is a label/identity prop only — it does NOT wire a handler, so the
          // click has to be bound explicitly or the button is inert (it was, before the
          // panels refactor: onRefresh was computed and never attached).
          <UiButton action="refresh" content="icon" variant="plain" aria-label={`Refresh ${title}`} title="Refresh" disabled={loading} onClick={onRefresh}>
            <RefreshCw
              className={`w-3.5 h-3.5 text-content-muted hover:text-content-secondary ${loading ? "animate-spin" : ""}`}
            />
          </UiButton>
        )}
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

export function defineResourcePanel<T>(def: ResourcePanelDef<T>): PanelContribution {
  function Panel({ ctx }: { ctx: PanelContext }) {
    const send = ctx.sendResourceReq;
    const { data, loading, error, refetch } = useResourceQuery<T>(
      // Held off entirely when the surface has no resource channel, so the no-op
      // below is never actually called.
      send ?? (() => Promise.resolve(null)),
      def.verb,
      def.makeParams(ctx),
      !!ctx.channelId && !!send
    );
    const onRefresh = useCallback(() => refetch(), [refetch]);
    const Icon = def.icon;

    // Live-push: re-fetch when this panel's tick bumps (a board_signal arrived).
    // Deferred while the panel is kept-alive but hidden; catches up on reveal.
    usePanelTickRefetch(ctx, def.id, refetch);

    return (
      <div className="flex flex-col h-full text-regular">
        <div className="mx-3 mt-1 flex h-9 flex-shrink-0 items-center gap-2 border-b border-zinc-800 px-1">
          {Icon && <Icon className="w-3.5 h-3.5 text-content-muted" />}
          <span className="text-compact text-content-secondary">{def.title}</span>
          <div className="flex-1" />
          {loading && <span className="text-minimal text-content-muted">Loading…</span>}
          <UiButton action="refresh" content="icon" variant="plain" aria-label={`Refresh ${def.title}`} title="Refresh" disabled={loading} onClick={onRefresh}>
            <RefreshCw
              className={`w-3.5 h-3.5 text-content-muted hover:text-content-secondary ${loading ? "animate-spin" : ""}`}
            />
          </UiButton>
        </div>

        <div className="flex-1 overflow-auto">
          {error ? (
            <div className="px-3 py-3 text-compact text-danger-400">{error}</div>
          ) : data == null ? (
            // First load (no data yet) — neutral hint, not the panel's "empty" state.
            <div className="px-3 py-6 text-compact text-content-muted">Loading…</div>
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
    surface: "lane",
    profiles: def.profiles,
    scope: def.scope,
    render: (ctx) => <Panel ctx={ctx} />,
  };
}

/** Register a verb-bound lane panel. */
export function registerResourcePanel<T>(def: ResourcePanelDef<T>): void {
  registerPanel(defineResourcePanel(def));
}

/** Standard params for a session-scoped panel: `{ channel_id, session_id? }`. */
export function channelSessionParams(ctx: PanelContext): Record<string, unknown> {
  return {
    channel_id: ctx.channelId,
    ...(ctx.scopeSessionId ? { session_id: ctx.scopeSessionId } : {}),
  };
}
