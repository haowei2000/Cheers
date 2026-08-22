import { Button as UiButton } from "@/components/ui/button";
// The verb-bound panel factory. A resource panel renders a live, read-only PROJECTION
// of platform state read from a resource verb (`*.read`), keyed by channel and
// optionally the host's session scope. Truth lives in the event/session/usage stores,
// not in a file — which is what distinguishes it from an fs-source panel, and why it
// never offers a Save: a projection carries no version to write back against.
//
// Moved here from workbench/viewBoard.tsx unchanged in behavior; see
// docs/arch/PANEL_MODEL.md for why boards stopped being their own subsystem.
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { RefreshCw, type LucideIcon } from "lucide-react";
import { FloatingPanelActionPortal } from "@/components/ui/floating-panel";
import { registerPanel, type PanelContext, type PanelContribution } from "./registry";
import { tickKeyFor, usePanelData, type PanelSource } from "./source";

// Trailing-coalesce window for tick-driven refetches. A user↔bot exchange or a
// board_signal burst bumps the tick several times in quick succession; without this
// each bump fired a full refetch (e.g. the Activity panel pulls 200 events + the
// member list). We fire the first bump immediately (zero latency for a lone message)
// then swallow further bumps into one trailing refetch per window.
const PANEL_REFETCH_DEBOUNCE_MS = 500;

/** Tick-driven refetch that (a) skips the mount (usePanelData / the panel's own
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

export interface DataPanelDef<T> {
  id: string;
  title: string;
  icon?: LucideIcon;
  profiles?: string[];
  /** Where this panel's data lives. The panel declares it and nothing else — one
   *  loader serves every kind. */
  source: PanelSource;
  /** When "session", the host shows its session-scope selector. */
  scope?: "channel" | "session";
  /** Render the loaded data (owns both the populated and the empty presentation).
   *  `refetch` lets an actionable panel (e.g. Sessions: create/close) refresh itself
   *  after a lightweight control action. */
  render: (data: T, ctx: PanelContext, refetch: () => void) => ReactNode;
}

function PanelRefreshAction({
  title,
  loading,
  onRefresh,
  active = true,
}: {
  title: string;
  loading?: boolean;
  onRefresh: () => void;
  active?: boolean;
}) {
  const action = useMemo(
    () => ({
      id: `refresh-${title.toLowerCase().replaceAll(" ", "-")}`,
      label: `Refresh ${title}`,
      priority: "primary" as const,
      icon: RefreshCw,
      disabled: loading,
      onSelect: onRefresh,
      control: (
        <UiButton
          action="refresh"
          content="icon"
          controlSize="compact"
          variant="plain"
          aria-label={`Refresh ${title}`}
          title="Refresh"
          disabled={loading}
          onClick={onRefresh}
          className="rounded-sm text-content-primary hover:bg-zinc-800 hover:text-content-strong"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </UiButton>
      ),
    }),
    [loading, onRefresh, title]
  );
  return <FloatingPanelActionPortal action={action} active={active} />;
}

/** Standard body host. Identity and refresh live in FloatingPanel chrome. */
export function PanelShell({
  title,
  loading,
  onRefresh,
  active = true,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  loading?: boolean;
  onRefresh?: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full text-regular">
      {onRefresh && (
        <PanelRefreshAction title={title} loading={loading} onRefresh={onRefresh} active={active} />
      )}
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

export function defineDataPanel<T>(def: DataPanelDef<T>): PanelContribution {
  function Panel({ ctx }: { ctx: PanelContext }) {
    const { data, loading, error, refetch } = usePanelData<T>(def.source, ctx);
    const onRefresh = useCallback(() => refetch(), [refetch]);

    // Live-push: re-fetch when the signal for THIS SOURCE bumps — its own
    // board_signal for a verb, the shared files tick for a workspace file.
    // Deferred while the panel is kept-alive but hidden; catches up on reveal.
    usePanelTickRefetch(ctx, tickKeyFor(def.source, def.id), refetch);

    return (
      <div className="flex flex-col h-full text-regular">
        <PanelRefreshAction
          title={def.title}
          loading={loading}
          onRefresh={onRefresh}
          active={ctx.visible !== false}
        />

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

/** Register a lane panel that loads from a declared source. */
export function registerDataPanel<T>(def: DataPanelDef<T>): void {
  registerPanel(defineDataPanel(def));
}

/** Standard params for a session-scoped resource panel: `{ channel_id, session_id? }`. */
export function channelSessionParams(ctx: PanelContext): Record<string, unknown> {
  return {
    channel_id: ctx.channelId,
    ...(ctx.scopeSessionId ? { session_id: ctx.scopeSessionId } : {}),
  };
}
