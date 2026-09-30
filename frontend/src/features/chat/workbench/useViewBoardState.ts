import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useManagedPanel } from "@/components/ui/managed-panel";
import { useChannelProfile } from "@/hooks/useChannelProfile";
import { panelsFor, type PanelContext, type PanelContribution } from "@/features/chat/panels/registry";
import {
  useContextPickStore,
  type ContextItem,
} from "@/features/chat/context/contextPick";
import type { Message } from "@/types";
import type { SendResourceReq } from "./fsClient";

export const ACTIVE_BOARD_KEY = "cheers.viewboard.active";

// Boards that map to a resource verb an agent can resolve (docs/design/RESOURCE_CONTEXT.md).
// Audit is REST-only (no resource verb), so it isn't attachable as context.
export const ATTACHABLE_BOARDS: Record<string, { verb: string; kind: ContextItem["kind"] }> = {
  plan: { verb: "channel.plan.read", kind: "plan" },
  cost: { verb: "channel.usage.read", kind: "cost" },
  sessions: { verb: "channel.sessions.read", kind: "sessions" },
  activity: { verb: "channel.activity.read", kind: "activity" },
};

export interface SessionOpt {
  session_id: string;
  bot_id: string;
  bot_name?: string | null;
  is_primary: boolean;
  cwd?: string | null;
  created_at?: string | null;
  status?: string;
}

export function formatScopeLabel(scope: string, sessions: SessionOpt[]): string {
  if (!scope) return "All sessions";
  const session = sessions.find((candidate) => candidate.session_id === scope);
  if (!session) return "All sessions";
  return session.bot_name || session.bot_id.slice(0, 8);
}

export interface UseViewBoardStateOptions {
  open: boolean;
  channelId: string;
  sendResourceReq: SendResourceReq;
  /** Composer's selected session — accepted for API compatibility; the ViewBoard now
   *  drives its own session scope (defaults to "All sessions") so you can compare many. */
  selectedSessionId?: string | null;
  /** Live-push ticks (board id → counter) from the WS board_signal stream. */
  boardTick?: Record<string, number>;
  /** Minimal mode: a compact glance list in a narrower dock column. */
  minimal?: boolean;
  onToggleMinimal?: () => void;
  /** External "switch to this board" request (composer's "Manage sessions…").
   *  `nonce` lets a repeat request for the same board re-apply. */
  focusBoard?: { id: string; nonce: number };
  /** Best-effort "jump the chat to this message" (scroll + flash when loaded). */
  onJumpToMessage?: (msgId: string, requestId?: string | null) => void;
  /** Live pending permission cards for the minimal Approvals dropdown. */
  pendingApprovals?: Message[];
  currentUserId?: string;
}

export interface NavigationItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  selected: boolean;
  onSelect: () => void;
}

export interface UseViewBoardStateReturn {
  // Minimal & panel modes
  managed: boolean;
  minimal: boolean;
  toggleMinimal: () => void;
  expandToBoard: (boardId: string, expand?: () => void) => void;

  // Board registry & navigation
  boards: PanelContribution[];
  activeBoard: PanelContribution | undefined;
  activeId: string | undefined;
  setActive: (id: string) => void;
  visited: ReadonlySet<string>;
  navigationItems: NavigationItem[];

  // Session scoping
  scope: string;
  setScope: (scope: string) => void;
  scopeLabel: string;
  sessions: SessionOpt[];

  // Context picking
  canAttachActiveBoard: boolean;
  addActiveBoardToContext: () => void;

  // Shared context
  ctx: PanelContext;
}

export function useViewBoardState({
  open,
  channelId,
  sendResourceReq,
  boardTick,
  minimal: requestedMinimal,
  onToggleMinimal,
  focusBoard,
  onJumpToMessage,
  pendingApprovals,
  currentUserId,
}: UseViewBoardStateOptions): UseViewBoardStateReturn {
  const managed = Boolean(useManagedPanel("viewboard"));
  const minimal = !managed && Boolean(requestedMinimal);

  const profile = useChannelProfile(channelId, open, boardTick?.["github-code"]);
  const boards = useMemo(() => panelsFor("lane", profile?.profile), [profile?.profile]);

  const [active, setActiveState] = useState<string>(() => {
    try {
      return localStorage.getItem(ACTIVE_BOARD_KEY) ?? "";
    } catch {
      return "";
    }
  });

  const activeBoard = useMemo(
    () => boards.find((b) => b.id === active) ?? boards[0],
    [boards, active]
  );
  const activeId = activeBoard?.id;

  const setActive = useCallback((id: string) => {
    setActiveState(id);
    try {
      localStorage.setItem(ACTIVE_BOARD_KEY, id);
    } catch {
      /* ignore storage errors */
    }
  }, []);

  // External board-switch request (e.g. composer's "Manage sessions…").
  useEffect(() => {
    if (focusBoard?.id) {
      setActive(focusBoard.id);
    }
  }, [focusBoard, setActive]);

  // Keep-alive: boards visited this channel stay mounted (hidden) so tab switches
  // don't remount → refetch → lose scroll/filter state. Reset on channel change.
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setVisited(new Set());
  }, [channelId]);

  useEffect(() => {
    if (!activeId) return;
    setVisited((v) => (v.has(activeId) ? v : new Set(v).add(activeId)));
  }, [activeId]);

  // The ViewBoard's OWN session scope ("" = All sessions), independent of the composer's
  // send target, so Plan / Cost can show many sessions at once or focus on one.
  const [scope, setScope] = useState<string>("");
  const [sessions, setSessions] = useState<SessionOpt[]>([]);

  // Reset the scope when the channel changes (its session set is different).
  useEffect(() => {
    setScope("");
  }, [channelId]);

  const cidRef = useRef(channelId);
  cidRef.current = channelId;

  const sessionsTick = boardTick?.sessions ?? 0;
  const activityTick = boardTick?.activity ?? 0;

  const loadSessions = useCallback(async () => {
    const cid = channelId;
    if (!open || !cid || !sendResourceReq) return;
    try {
      const res = (await sendResourceReq("channel.sessions.read", {
        channel_id: cid,
      })) as {
        sessions?: Array<{
          session_id: string;
          bot_id: string;
          bot_name?: string | null;
          is_primary?: boolean;
          created_at?: string | null;
          status?: string;
          workspace?: { cwd?: string | null };
        }>;
      };
      if (cidRef.current !== cid) return;
      setSessions(
        (res.sessions ?? []).map((s) => ({
          session_id: s.session_id,
          bot_id: s.bot_id,
          bot_name: s.bot_name ?? null,
          is_primary: Boolean(s.is_primary),
          cwd: s.workspace?.cwd ?? null,
          created_at: s.created_at ?? null,
          status: s.status,
        }))
      );
    } catch {
      /* selector falls back to "All sessions" only */
    }
  }, [open, channelId, sendResourceReq]);

  // Load sessions when drawer opens or sessionsTick changes
  useEffect(() => {
    loadSessions();
  }, [loadSessions, sessionsTick]);

  // Sessions have no dedicated signal — refresh on the per-message "activity" tick (debounced)
  const lastActivity = useRef(activityTick);
  useEffect(() => {
    if (activityTick === lastActivity.current) return;
    lastActivity.current = activityTick;
    const t = setTimeout(() => {
      loadSessions();
    }, 800);
    return () => clearTimeout(t);
  }, [activityTick, loadSessions]);

  const scopeLabel = useMemo(
    () => formatScopeLabel(scope, sessions),
    [scope, sessions]
  );

  const canAttachActiveBoard = Boolean(activeBoard && ATTACHABLE_BOARDS[activeBoard.id]);

  const addActiveBoardToContext = useCallback(() => {
    if (!activeBoard) return;
    const meta = ATTACHABLE_BOARDS[activeBoard.id];
    if (!meta) return;
    const scoped = activeBoard.scope === "session" && Boolean(scope);
    useContextPickStore.getState().add(channelId, {
      id: scoped ? `${activeBoard.id}:${scope}` : activeBoard.id,
      verb: meta.verb,
      params: scoped ? { session_id: scope } : {},
      label: activeBoard.title,
      kind: meta.kind,
    });
  }, [activeBoard, channelId, scope]);

  const toggleMinimal = useCallback(() => {
    onToggleMinimal?.();
  }, [onToggleMinimal]);

  const expandToBoard = useCallback(
    (boardId: string, expand?: () => void) => {
      setActive(boardId);
      if (expand) {
        expand();
      } else if (minimal && onToggleMinimal) {
        onToggleMinimal();
      }
    },
    [setActive, minimal, onToggleMinimal]
  );

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
    ]
  );

  const navigationItems = useMemo(
    () =>
      boards.map((board) => ({
        id: board.id,
        label: board.title,
        icon: board.icon,
        selected: activeBoard?.id === board.id,
        onSelect: () => setActive(board.id),
      })),
    [boards, activeBoard?.id, setActive]
  );

  return {
    managed,
    minimal,
    toggleMinimal,
    expandToBoard,
    boards,
    activeBoard,
    activeId,
    setActive,
    visited,
    navigationItems,
    scope,
    setScope,
    scopeLabel,
    sessions,
    canAttachActiveBoard,
    addActiveBoardToContext,
    ctx,
  };
}
