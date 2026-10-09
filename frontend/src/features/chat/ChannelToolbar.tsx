import { AnnotationsLauncher } from "@/features/annotations/AnnotationProvider";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, LayoutGrid, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { usePopoverDismiss } from "@/components/ui/popover";
import { MembersPopover } from "./MembersPopover";
import { PopoverPanel } from "@/components/ui/popover";
import { MenuOption } from "@/components/ui/menu-option";
import { useContextSurface, type ContextAction } from "@/components/ui/context-actions";
import { LANE_WINDOWS } from "@/features/chat/panels/laneWindows";
import type { PanelContribution } from "@/features/chat/panels/registry";
import type { SpawnKind } from "@/features/chat/workbench/laneSnap";
import type { MemberItem } from "@/types";

type Props = {
  channelId: string;
  isDm: boolean;
  memberCount: number;
  onlineCount: number;
  filesOpen: boolean;
  workspaceOpen: boolean;
  viewBoardOpen: boolean;
  workbenchOpen: boolean;
  onManage: () => void;
  currentUserId?: string;
  onMentionMember?: (member: MemberItem) => void;
  onStartDm?: (member: MemberItem) => void;
  onToggleFiles: () => void;
  onToggleWorkspace: () => void;
  onToggleViewBoard: () => void;
  onToggleWorkbench: () => void;
  /** Lane boards for this channel's profile — built-in and package-contributed alike. */
  boards: PanelContribution[];
  /** Open the ViewBoard focused on a board. */
  onOpenBoard: (id: string) => void;
};

export function ChannelToolbar(props: Props) {
  const [membersOpen, setMembersOpen] = useState(false);
  const membersRootRef = useRef<HTMLDivElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  usePopoverDismiss(membersOpen, closeMembers, membersRootRef);
  useEffect(() => setMembersOpen(false), [props.channelId]);

  const [panelsOpen, setPanelsOpen] = useState(false);
  const panelsRootRef = useRef<HTMLDivElement>(null);
  const panelsButtonRef = useRef<HTMLButtonElement>(null);
  const panelsMenuRef = useRef<HTMLDivElement>(null);
  const closePanels = useCallback(() => setPanelsOpen(false), []);
  usePopoverDismiss(panelsOpen, closePanels, panelsRootRef);
  useEffect(() => setPanelsOpen(false), [props.channelId]);

  useEffect(() => {
    if (!panelsOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const active = panelsMenuRef.current?.querySelector<HTMLButtonElement>(
        "[role='menuitemcheckbox'][aria-checked='true']:not(:disabled)",
      );
      const first = panelsMenuRef.current?.querySelector<HTMLButtonElement>(
        "[role^='menuitem']:not(:disabled)",
      );
      (active ?? first)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelsOpen]);

  const onPanelsMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanels();
      panelsButtonRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      panelsMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)") ?? [],
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };

  // Window open-state and toggles stay keyed by SpawnKind — ChannelView owns each
  // window's own props, so the picker only needs identity plus on/off.
  const windowOpen: Record<SpawnKind, boolean> = {
    files: props.filesOpen,
    workspace: props.workspaceOpen,
    viewboard: props.viewBoardOpen,
    workbench: props.workbenchOpen,
  };
  const toggleWindow: Record<SpawnKind, () => void> = {
    files: props.onToggleFiles,
    workspace: props.onToggleWorkspace,
    viewboard: props.onToggleViewBoard,
    workbench: props.onToggleWorkbench,
  };
  const openCount = LANE_WINDOWS.filter((w) => windowOpen[w.id]).length;
  const panelContextSurface = useContextSurface({
    surfaceRef: panelsButtonRef,
    actions: () => {
      const actions: ContextAction[] = [
        {
          id: "open-picker",
          label: "Open panels picker",
          icon: <LayoutGrid className="h-4 w-4" />,
          run: () => setPanelsOpen(true),
        },
      ];
      for (const { id, title, icon: Icon } of LANE_WINDOWS) {
        actions.push({
          id: `toggle-${id}`,
          label: `${windowOpen[id] ? "Hide" : "Show"} ${title}`,
          icon: windowOpen[id] ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />,
          group: "secondary",
          run: () => {
            closePanels();
            toggleWindow[id]();
          },
        });
      }
      for (const board of props.boards) {
        const Icon = board.icon;
        actions.push({
          id: `board-${board.id}`,
          label: `Open ${board.title}`,
          icon: Icon ? <Icon className="h-4 w-4" /> : undefined,
          group: "secondary",
          run: () => {
            props.onOpenBoard(board.id);
            closePanels();
          },
        });
      }
      return actions;
    },
  });

  return (
    <>
      <AnnotationsLauncher />
      <div className="relative hidden md:block" ref={membersRootRef}>
        <ControlTrigger
          controlWidth="content"
          controlSize="compact"
          type="button"
          onClick={() => setMembersOpen((open) => !open)}
          title={
            props.onlineCount > 0
              ? `Channel roster (${props.memberCount || 0} members, ${props.onlineCount} online)`
              : `Channel roster (${props.memberCount || 0})`
          }
          aria-label={
            props.onlineCount > 0
              ? `Channel roster: ${props.memberCount || 0} members, ${props.onlineCount} online`
              : `Channel roster: ${props.memberCount || 0} members`
          }
          aria-expanded={membersOpen}
          aria-haspopup="dialog"
          selected={membersOpen}
        >
          <span className="font-code text-minimal uppercase tracking-overline text-content-muted/80">
            ROSTER
          </span>
          <span className="font-code text-minimal text-content-muted/40">·</span>
          <span className="font-code text-compact tabular-nums font-medium text-content-primary">
            {props.memberCount || 0}
          </span>
        </ControlTrigger>
        {membersOpen && (
          <MembersPopover
            channelId={props.channelId}
            isDm={props.isDm}
            onManage={props.onManage}
            onClose={closeMembers}
            currentUserId={props.currentUserId}
            onMention={props.onMentionMember}
            onStartDm={props.onStartDm}
          />
        )}
      </div>

      {/* One control for every lane surface. Windows are containers ChannelView renders
          with their own props; boards are content inside the ViewBoard — listing both
          here is what makes a package-contributed board reachable without knowing it
          lives behind the ViewBoard tab strip. */}
      <div className="relative" ref={panelsRootRef}>
        <Button
          ref={panelsButtonRef}
          variant="plain"
          onClick={() => setPanelsOpen((open) => !open)}
          onContextMenu={panelContextSurface.onContextMenu}
          onKeyDown={panelContextSurface.onKeyDown}
          onPointerDown={panelContextSurface.onPointerDown}
          onPointerMove={panelContextSurface.onPointerMove}
          onPointerUp={panelContextSurface.onPointerUp}
          onPointerCancel={panelContextSurface.onPointerCancel}
          onPointerLeave={panelContextSurface.onPointerLeave}
          onClickCapture={panelContextSurface.onClickCapture}
          title="Panels"
          aria-label="Panels"
          aria-expanded={panelsOpen}
          aria-haspopup="menu"
          content="icon"
          controlSize="compact"
          selected={panelsOpen || openCount > 0}
        >
          <LayoutGrid className="w-4 h-4" aria-hidden="true" />
        </Button>
        {panelsOpen && (
          <PopoverPanel
            placement="down"
            align="end"
            className="z-50 w-72 max-h-[70vh] overflow-y-auto p-1"
          >
            <div
              ref={panelsMenuRef}
              role="menu"
              tabIndex={-1}
              aria-label="Panels"
              onKeyDown={onPanelsMenuKeyDown}
            >
              <div className="px-2 pb-1 pt-1 text-minimal uppercase tracking-label text-content-muted">
                Windows
              </div>
              {LANE_WINDOWS.map(({ id, title, icon: Icon, description }) => (
                <MenuOption
                  key={id}
                  controlSize="regular"
                  label={title}
                  trailing={<span className="text-minimal text-content-muted">{description}</span>}
                  selected={windowOpen[id]}
                  // A window row toggles something on and off, so it is a checkbox item,
                  // not a plain action. MenuOption paints `selected` but sets no ARIA,
                  // and spreads props after its own role — so this is where the state
                  // becomes announceable. Board rows below stay plain menuitems: they
                  // navigate, they do not toggle.
                  role="menuitemcheckbox"
                  aria-checked={windowOpen[id]}
                  leading={<Icon className="h-3.5 w-3.5" aria-hidden="true" />}
                  onClick={() => {
                    toggleWindow[id]();
                    closePanels();
                  }}
                />
              ))}
              {props.boards.length > 0 && (
                <>
                  <div className="mt-1 px-2 pb-1 pt-1 text-minimal uppercase tracking-label text-content-muted">
                    Boards
                  </div>
                  {props.boards.map((board) => {
                    const Icon = board.icon;
                    return (
                      <MenuOption
                        key={board.id}
                        controlSize="regular"
                        label={board.title}
                        leading={Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : undefined}
                        onClick={() => {
                          props.onOpenBoard(board.id);
                          closePanels();
                        }}
                      />
                    );
                  })}
                </>
              )}
            </div>
          </PopoverPanel>
        )}
      </div>

      {!props.isDm && (
        <Button
          variant="plain"
          onClick={props.onManage}
          title="Channel settings"
          aria-label="Channel settings"
          content="icon"
          controlSize="compact"
          className="ml-2"
        >
          <Settings className="w-4 h-4" aria-hidden="true" />
        </Button>
      )}
    </>
  );
}
