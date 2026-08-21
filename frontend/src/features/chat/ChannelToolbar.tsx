import { useCallback, useEffect, useRef, useState } from "react";
import { FolderTree, LayoutDashboard, PanelRight, Paperclip, Settings, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { PresenceDot } from "@/components/ui/presence-dot";
import { usePopoverDismiss } from "@/components/ui/popover";
import { MembersPopover } from "./MembersPopover";
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
};

export function ChannelToolbar(props: Props) {
  const [membersOpen, setMembersOpen] = useState(false);
  const membersRootRef = useRef<HTMLDivElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  usePopoverDismiss(membersOpen, closeMembers, membersRootRef);
  useEffect(() => setMembersOpen(false), [props.channelId]);

  const controls = [
    {
      label: "Channel files",
      open: props.filesOpen,
      onClick: props.onToggleFiles,
      icon: Paperclip,
    },
    {
      label: "Remote workspace",
      open: props.workspaceOpen,
      onClick: props.onToggleWorkspace,
      icon: FolderTree,
    },
    {
      label: "ViewBoard",
      open: props.viewBoardOpen,
      onClick: props.onToggleViewBoard,
      icon: LayoutDashboard,
    },
    {
      label: "Workbench",
      open: props.workbenchOpen,
      onClick: props.onToggleWorkbench,
      icon: PanelRight,
    },
  ] as const;

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

      {controls.map(({ label, open, onClick, icon: Icon }) => (
        <Button
          key={label}
          variant="plain"
          onClick={onClick}
          title={label}
          aria-label={label}
          content="icon"
          controlSize="compact"
          selected={open}
        >
          <Icon className="w-4 h-4" aria-hidden="true" />
        </Button>
      ))}

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
