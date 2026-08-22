import { Button as UiButton } from "@/components/ui/button";
import { Select as UiSelect } from "@/components/ui/select";
// ViewBoardDrawer — host for the channel's ViewBoards (the instrument plane),
// SEPARATE from the file-based Workbench. On desktop it's a draggable/resizable
// floating window inside the channel's work lane; dragging snaps it to the lane's
// grid zones. On mobile it stays a near-full-screen overlay sheet.
import { memo, useEffect, useMemo, useState } from "react";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { LayoutDashboard, Layers, Plus } from "lucide-react";
import {
  useContextPickStore,
  type ContextItem,
} from "@/features/chat/context/contextPick";
import { addToContextTitle } from "@/features/chat/context/contextLabels";
import { sessionTag } from "@/features/chat/sessionLabel";
import type { SendResourceReq } from "./fsClient";
import { panelsFor, type PanelContext } from "@/features/chat/panels/registry";
import { ViewBoardMinimized } from "./ViewBoardMinimized";
import type { Message } from "@/types";
import { useChannelProfile } from "@/hooks/useChannelProfile";
// Built-in boards register themselves on import (side effect).
import "./panels/PlanBoardPanel";
import "./panels/CostPanel";
import "./panels/SessionsPanel";
import "./panels/AuditPanel";
import "./panels/ActivityPanel";
import "@/features/chat/panels/builtin/githubCode";

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
  onJumpToMessage?: (msgId: string, requestId?: string | null) => void;
  /** Live pending permission cards for the minimal Approvals dropdown. */
  pendingApprovals?: Message[];
  currentUserId?: string;
  /** External "switch to this board" request (composer's "Manage sessions…").
   *  `nonce` lets a repeat request for the same board re-apply. */
  focusBoard?: { id: string; nonce: number };
}

const ACTIVE_BOARD_KEY = "cheers.viewboard.active"; // last-viewed board, restored on reload

// Boards that map to a resource verb an agent can resolve (docs/design/RESOURCE_CONTEXT.md).
// Audit is REST-only (no resource verb), so it isn't attachable as context.
const ATTACHABLE_BOARDS: Record<string, { verb: string; kind: ContextItem["kind"] }> = {
  plan: { verb: "channel.plan.read", kind: "plan" },
  cost: { verb: "channel.usage.read", kind: "cost" },
  sessions: { verb: "channel.sessions.read", kind: "sessions" },
  activity: { verb: "channel.activity.read", kind: "activity" },
};

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
  pendingApprovals,
  currentUserId,
  focusBoard,
}: Props) {
  const profile = useChannelProfile(channelId, open, boardTick?.["github-code"]);
  // Contributed panels are loaded by ChannelView (useExtensionPanels) so the toolbar's
  // picker can list them before this drawer has ever been opened.
  const boards = panelsFor("lane", profile?.profile);
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

  const ctx: PanelContext = useMemo(
    () => ({
      channelId,
      sendResourceReq,
      scopeSessionId: scope || null,
      tick: boardTick,
      onJumpToMessage,
      pendingApprovals,
      currentUserId,
      profile,
    }),
    [
      channelId,
      sendResourceReq,
      scope,
      boardTick,
      onJumpToMessage,
      pendingApprovals,
      currentUserId,
      profile,
    ],
  );

  const addActiveBoardToContext = () => {
    if (!activeBoard) return;
    const meta = ATTACHABLE_BOARDS[activeBoard.id];
    if (!meta) return;
    const scoped = activeBoard.scope === "session" && scope;
    useContextPickStore.getState().add(channelId, {
      id: scoped ? `${activeBoard.id}:${scope}` : activeBoard.id,
      verb: meta.verb,
      params: scoped ? { session_id: scope } : {},
      label: activeBoard.title,
      kind: meta.kind,
    });
  };

  // Desktop: a draggable/resizable floating window inside the work lane; dragging
  // snaps it to the lane's grid zones. Minimal collapses to a glance card that keeps
  // its dragged spot. Closed keeps it MOUNTED so visited-board state survives. Mobile
  // is a full-screen sheet. All of that is FloatingPanel's job — see its `open` and
  // `collapsed` props; `minimal` is controlled because useChannelInstruments owns it.
  return (
    <FloatingPanel
      title="ViewBoard"
      icon={LayoutDashboard}
      onClose={onClose}
      storageKey="cheers.float.viewboard"
      open={open}
      collapsed={minimal}
      onToggleCollapsed={onToggleMinimal}
      spawnKind="viewboard"
      className="w-[420px] h-[70%]"
      defaultPosClassName="top-2 left-2"
      // Tab strip + scope selector + the keep-alive stack are a non-scrolling flex
      // column; each board owns its own scrolling.
      bodyClassName="flex flex-col overflow-hidden p-0 space-y-0 md:pt-[var(--floating-panel-safe-top)]"
      primaryNavigation={{
        ariaLabel: "ViewBoard sections",
        items: boards.map((board) => ({
          id: board.id,
          label: board.title,
          icon: board.icon,
          selected: activeBoard?.id === board.id,
          onSelect: () => setActive(board.id),
        })),
      }}
      panelActions={activeBoard && ATTACHABLE_BOARDS[activeBoard.id] ? [{
        id: "add-context",
        label: "Add board to context",
        priority: "secondary",
        icon: Plus,
        onSelect: addActiveBoardToContext,
        control: (
          <UiButton
            variant="plain"
            content="icon"
            controlSize="compact"
            onClick={addActiveBoardToContext}
            title={addToContextTitle("this board")}
            className="rounded-sm text-content-primary hover:bg-zinc-800 hover:text-accent-300"
          >
            <Plus className="w-3.5 h-3.5" />
          </UiButton>
        ),
      }] : []}
      collapsedSummary={(expand) => (
        // Minimized: a purpose-built glance (not the board shrunk). Clicking a row
        // expands straight to that board.
        <ViewBoardMinimized
          ctx={ctx}
          onExpand={(id) => {
            setActive(id);
            expand();
          }}
        />
      )}
    >
      <div
        className="mx-3 mb-2 flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 px-0 py-1 md:hidden"
        role="tablist"
        aria-label="ViewBoard sections"
      >
        {boards.map((b) => {
          const isActive = activeBoard?.id === b.id;
          const Icon = b.icon;
          return (
            <UiButton
              variant="plain"
              role="tab"
              aria-selected={isActive}
              key={b.id}
              onClick={() => setActive(b.id)}
              controlSize="regular"
              className={`inline-flex flex-shrink-0 items-center gap-2 rounded-none border-b whitespace-nowrap transition-colors ${
                isActive
                  ? "border-zinc-200 text-content-primary"
                  : "border-transparent text-content-primary hover:text-content-strong"
              }`}
            >
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {b.title}
            </UiButton>
          );
        })}
      </div>

      {activeBoard?.scope === "session" && (
        <div className="mx-3 mb-2 flex flex-shrink-0 items-center gap-2 border-b border-zinc-800 px-1 py-2">
          <Layers className="w-3.5 h-3.5 text-content-muted flex-shrink-0" />
          <span className="text-minimal uppercase tracking-label text-content-muted">Scope</span>
          <UiSelect
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            controlSize="regular"
            className="min-w-0 flex-1 rounded-sm bg-zinc-800 text-compact text-content-secondary focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
          </UiSelect>
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
    </FloatingPanel>
  );
}

// Memoized: ChannelView re-renders on every streaming delta, but the drawer's props
// (stable callbacks + scalar ids + boardTick) only change on board signals, so this
// skips the whole board subtree during pure token streaming.
export const ViewBoardDrawer = memo(ViewBoardDrawerImpl);
