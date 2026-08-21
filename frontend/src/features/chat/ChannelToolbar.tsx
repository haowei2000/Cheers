import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid, Settings, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { PresenceDot } from "@/components/ui/presence-dot";
import { usePopoverDismiss } from "@/components/ui/popover";
import { MembersPopover } from "./MembersPopover";
import { PopoverPanel } from "@/components/ui/popover";
import { MenuOption } from "@/components/ui/menu-option";
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
  const closePanels = useCallback(() => setPanelsOpen(false), []);
  usePopoverDismiss(panelsOpen, closePanels, panelsRootRef);
  useEffect(() => setPanelsOpen(false), [props.channelId]);

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

  return (
    <>
      <div className="hidden md:flex items-center gap-3 text-compact text-content-muted">
        <div className="relative" ref={membersRootRef}>
          <ControlTrigger
            controlWidth="slot"
            type="button"
            onClick={() => setMembersOpen((open) => !open)}
            title="Channel members"
            aria-expanded={membersOpen}
            controlSize="regular"
            selected={membersOpen}
          >
            <Users className="w-3.5 h-3.5" aria-hidden="true" />
            {props.memberCount || "Members"}
            {props.onlineCount > 0 && (
              <span className="ml-1 flex items-center gap-2">
                <PresenceDot contentSize="small" className="bg-emerald-500" />
                {props.onlineCount} online
              </span>
            )}
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
      </div>

      {/* One control for every lane surface. Windows are containers ChannelView renders
          with their own props; boards are content inside the ViewBoard — listing both
          here is what makes a package-contributed board reachable without knowing it
          lives behind the ViewBoard tab strip. */}
      <div className="relative" ref={panelsRootRef}>
        <Button
          variant="plain"
          onClick={() => setPanelsOpen((open) => !open)}
          title="Panels"
          aria-label="Panels"
          aria-expanded={panelsOpen}
          aria-haspopup="menu"
          content="icon"
          controlSize="compact"
          selected={openCount > 0}
        >
          <LayoutGrid className="w-4 h-4" aria-hidden="true" />
        </Button>
        {panelsOpen && (
          <PopoverPanel
            placement="down"
            align="end"
            className="z-50 w-60 max-h-[70vh] overflow-y-auto p-1"
          >
            <div role="menu" aria-label="Panels">
              <div className="px-2 pb-1 pt-1 text-minimal uppercase tracking-label text-content-muted">
                Windows
              </div>
              {LANE_WINDOWS.map(({ id, title, icon: Icon }) => (
                <MenuOption
                  key={id}
                  controlSize="regular"
                  label={title}
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
