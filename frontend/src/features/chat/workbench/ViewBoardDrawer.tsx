import { memo, useMemo } from "react";
import { Button as UiButton } from "@/components/ui/button";
import { AddContextIcon } from "@/components/ui/editorial-icons";
import { DropdownSelect } from "@/components/ui/dropdown-select";
import { cn } from "@/lib/cn";
import { workbenchControlSize } from "./workbench-control";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { LayoutDashboard, ListFilter } from "lucide-react";
import { addToContextTitle } from "@/features/chat/context/contextLabels";
import { sessionTag } from "@/features/chat/sessionLabel";
import type { SendResourceReq } from "./fsClient";
import type { PanelContext, PanelContribution } from "@/features/chat/panels/registry";
import { ViewBoardMinimized } from "./ViewBoardMinimized";
import type { Message } from "@/types";
import {
  ACTIVE_BOARD_KEY,
  ATTACHABLE_BOARDS,
  formatScopeLabel,
  useViewBoardState,
  type SessionOpt,
  type UseViewBoardStateOptions,
  type UseViewBoardStateReturn,
} from "./useViewBoardState";

// Built-in boards register themselves on import (side effect).
import "./panels/PlanBoardPanel";
import "./panels/CostPanel";
import "./panels/SessionsPanel";
import "./panels/AuditPanel";
import "./panels/ActivityPanel";
import "@/features/chat/panels/builtin/githubCode";

// Re-export state utilities and constants for backward compatibility
export {
  ACTIVE_BOARD_KEY,
  ATTACHABLE_BOARDS,
  formatScopeLabel,
  useViewBoardState,
  type SessionOpt,
  type UseViewBoardStateOptions,
  type UseViewBoardStateReturn,
};

export interface ViewBoardDrawerProps {
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

interface ViewBoardScopeSelectorProps {
  scope: string;
  scopeLabel: string;
  sessions: SessionOpt[];
  onSelect: (scope: string) => void;
}

export const ViewBoardScopeSelector = memo(function ViewBoardScopeSelector({
  scope,
  scopeLabel,
  sessions,
  onSelect,
}: ViewBoardScopeSelectorProps) {
  const options = useMemo(
    () => [
      { value: "", label: "All sessions" },
      ...sessions.map((session) => ({
        value: session.session_id,
        label: `${session.bot_name || session.bot_id.slice(0, 8)} · ${sessionTag({
          is_primary: session.is_primary,
          session_id: session.session_id,
          cwd: session.cwd,
          when: session.created_at,
        })}`,
      })),
    ],
    [sessions]
  );

  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownSelect
        content="icon"
        leading={
          <ListFilter
            className="h-3.5 w-3.5 shrink-0 text-content-muted"
            aria-hidden="true"
          />
        }
        ariaLabel={`Scope: ${scopeLabel}`}
        active={Boolean(scope)}
        label={scopeLabel}
        value={scope}
        options={options}
        onSelect={onSelect}
        controlSize={workbenchControlSize.tab}
        menuClassName="max-w-80"
      />
    </div>
  );
});

interface ViewBoardContextActionProps {
  onAdd: () => void;
}

export const ViewBoardContextAction = memo(function ViewBoardContextAction({
  onAdd,
}: ViewBoardContextActionProps) {
  return (
    <UiButton
      variant="plain"
      content="icon"
      controlSize="compact"
      onClick={onAdd}
      title={addToContextTitle("this board")}
      className="rounded-sm text-content-primary hover:bg-control-hover hover:text-content-strong active:bg-control-active"
    >
      <AddContextIcon className="w-3.5 h-3.5" />
    </UiButton>
  );
});

interface ViewBoardMobileTabsProps {
  boards: PanelContribution[];
  activeId?: string;
  onSelect: (id: string) => void;
}

export const ViewBoardMobileTabs = memo(function ViewBoardMobileTabs({
  boards,
  activeId,
  onSelect,
}: ViewBoardMobileTabsProps) {
  return (
    <div
      className="mx-3 mb-2 flex shrink-0 items-center gap-1 overflow-x-auto border-b border-control/80 px-0 py-1 md:hidden"
      role="tablist"
      aria-label="ViewBoard sections"
    >
      {boards.map((b) => {
        const isActive = activeId === b.id;
        const Icon = b.icon;
        return (
          <UiButton
            variant="plain"
            role="tab"
            aria-selected={isActive}
            selected={isActive}
            key={b.id}
            onClick={() => onSelect(b.id)}
            controlSize="regular"
            className={cn(
              "inline-flex shrink-0 items-center gap-2 whitespace-nowrap transition-colors rounded-none border-b-2 bg-transparent ring-0 shadow-none -mb-px hover:bg-transparent",
              isActive
                ? "border-content-strong text-content-strong font-semibold"
                : "border-transparent text-content-primary hover:text-content-strong"
            )}
          >
            {Icon && <Icon className="w-3.5 h-3.5" />}
            {b.title}
          </UiButton>
        );
      })}
    </div>
  );
});

interface ViewBoardContentProps {
  open: boolean;
  boards: PanelContribution[];
  activeId?: string;
  visited: ReadonlySet<string>;
  ctx: PanelContext;
}

export const ViewBoardContent = memo(function ViewBoardContent({
  open,
  boards,
  activeId,
  visited,
  ctx,
}: ViewBoardContentProps) {
  if (!open) return null;

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      {boards
        .filter((b) => visited.has(b.id) || b.id === activeId)
        .map((b) => {
          const isActive = b.id === activeId;
          return (
            <div key={b.id} className={isActive ? "h-full" : "hidden"}>
              {b.render({ ...ctx, visible: isActive })}
            </div>
          );
        })}
    </div>
  );
});

// ViewBoardDrawer — host for the channel's ViewBoards (the instrument plane),
// SEPARATE from the file-based Workbench. On desktop it's a draggable/resizable
// floating window inside the channel's work lane; dragging snaps it to the lane's
// grid zones. On mobile it stays a near-full-screen overlay sheet.
function ViewBoardDrawerImpl({
  open,
  onClose,
  channelId,
  sendResourceReq,
  selectedSessionId,
  boardTick,
  minimal: requestedMinimal,
  onToggleMinimal,
  onJumpToMessage,
  pendingApprovals,
  currentUserId,
  focusBoard,
}: ViewBoardDrawerProps) {
  const state = useViewBoardState({
    open,
    channelId,
    sendResourceReq,
    selectedSessionId,
    boardTick,
    minimal: requestedMinimal,
    onToggleMinimal,
    focusBoard,
    onJumpToMessage,
    pendingApprovals,
    currentUserId,
  });

  return (
    <FloatingPanel
      title="ViewBoard"
      icon={LayoutDashboard}
      onClose={onClose}
      storageKey="cheers.float.viewboard"
      open={open}
      collapsed={state.minimal}
      onToggleCollapsed={state.toggleMinimal}
      spawnKind="viewboard"
      className="w-[420px] h-[70%]"
      defaultPosClassName="top-2 left-2"
      bodyClassName="flex flex-col overflow-hidden p-0 space-y-0"
      primaryNavigation={{
        ariaLabel: "ViewBoard sections",
        presentationOrder: ["icon", "collapsed"],
        collapsedContent: "icon",
        items: state.navigationItems,
      }}
      panelContext={
        state.activeBoard?.scope === "session" ? (
          <ViewBoardScopeSelector
            scope={state.scope}
            scopeLabel={state.scopeLabel}
            sessions={state.sessions}
            onSelect={state.setScope}
          />
        ) : undefined
      }
      panelActions={
        state.canAttachActiveBoard
          ? [
              {
                id: "add-context",
                label: "Add board to context",
                priority: "secondary",
                icon: AddContextIcon,
                onSelect: state.addActiveBoardToContext,
                control: (
                  <ViewBoardContextAction onAdd={state.addActiveBoardToContext} />
                ),
              },
            ]
          : []
      }
      collapsedSummary={(expand) => (
        <ViewBoardMinimized
          ctx={state.ctx}
          sessions={state.sessions}
          onExpand={(id) => state.expandToBoard(id, expand)}
        />
      )}
    >
      <ViewBoardMobileTabs
        boards={state.boards}
        activeId={state.activeBoard?.id}
        onSelect={state.setActive}
      />

      <ViewBoardContent
        open={open}
        boards={state.boards}
        activeId={state.activeBoard?.id}
        visited={state.visited}
        ctx={state.ctx}
      />
    </FloatingPanel>
  );
}

// Memoized: ChannelView re-renders on every streaming delta, but the drawer's props
// (stable callbacks + scalar ids + boardTick) only change on board signals, so this
// skips the whole board subtree during pure token streaming.
export const ViewBoardDrawer = memo(ViewBoardDrawerImpl);
