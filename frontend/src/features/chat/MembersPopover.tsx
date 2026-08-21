import { Button as UiButton } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { AtSign, Bot, MessageCircle, Settings, UserRound, Users } from "lucide-react";
import { listChannelMembers } from "@/api/channels";
import { Avatar } from "@/components/ui/avatar";
import { PopoverPanel } from "@/components/ui/popover";
import { EntityItem, ItemList, OperationsItem } from "@/components/ui/item";
import { useProfileCard } from "./ProfileHovercard";
import type { MemberItem } from "@/types";
import { useContextSurface, type ContextAction } from "@/components/ui/context-actions";

function MemberRow({
  member,
  currentUserId,
  onOpenProfile,
  onMention,
  onStartDm,
}: {
  member: MemberItem;
  currentUserId?: string;
  onOpenProfile: (anchor: HTMLElement, member: MemberItem) => void;
  onMention?: (member: MemberItem) => void;
  onStartDm?: (member: MemberItem) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const name = member.display_name || member.username || member.member_id.slice(0, 8);
  const isSelf = member.member_id === currentUserId;
  const openProfile = () => {
    const anchor = surfaceRef.current;
    if (anchor) onOpenProfile(anchor, member);
  };
  const contextSurface = useContextSurface({
    surfaceRef,
    actions: () => [
      { id: "profile", label: "View profile", icon: <UserRound className="h-4 w-4" />, run: openProfile },
      ...(!isSelf && onMention ? [{ id: "mention", label: `Mention @${name}`, icon: <AtSign className="h-4 w-4" />, group: "secondary", run: () => onMention(member) } satisfies ContextAction] : []),
      ...(!isSelf && onStartDm ? [{ id: "dm", label: "Start direct message", icon: <MessageCircle className="h-4 w-4" />, run: () => onStartDm(member) } satisfies ContextAction] : []),
    ],
  });
  return (
    // Context-menu gestures are delegated to the semantic EntityItem button.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={surfaceRef}
      role="group"
      onContextMenu={contextSurface.onContextMenu}
      onKeyDown={contextSurface.onKeyDown}
      onPointerDown={contextSurface.onPointerDown}
      onPointerMove={contextSurface.onPointerMove}
      onPointerUp={contextSurface.onPointerUp}
      onPointerCancel={contextSurface.onPointerCancel}
      onPointerLeave={contextSurface.onPointerLeave}
      onClickCapture={contextSurface.onClickCapture}
    >
      <EntityItem
        onClick={openProfile}
        title={name}
        leading={<Avatar name={name} src={member.avatar_url ?? undefined} id={member.member_id} size="regular" online={member.is_online ?? undefined} />}
        status={member.member_type === "bot" ? <Bot className="h-3.5 w-3.5 text-accent-400" /> : undefined}
        trailing={member.role && member.role !== "member" ? <span className="text-minimal capitalize text-content-muted">{member.role}</span> : undefined}
      />
    </div>
  );
}

/**
 * Header "Members" dropdown — the quick answer to "who is in this channel?".
 * Read-only list (avatar · name · role · liveness); management stays in
 * ChannelSettingsDialog, reachable via the footer button for non-DM channels.
 *
 * Dismissal (outside click / Esc) is owned by the trigger wrapper in
 * ChannelView via `usePopoverDismiss` — an anchored panel, NOT a fixed
 * backdrop: the header's backdrop-blur makes it the containing block for
 * `fixed` descendants, which would clip an overlay to the 48px header strip.
 */
export function MembersPopover({
  channelId,
  isDm,
  onManage,
  onClose,
  currentUserId,
  onMention,
  onStartDm,
}: {
  channelId: string;
  isDm: boolean;
  onManage: () => void;
  onClose: () => void;
  currentUserId?: string;
  onMention?: (member: MemberItem) => void;
  onStartDm?: (member: MemberItem) => void;
}) {
  const [members, setMembers] = useState<MemberItem[] | null>(null);
  const card = useProfileCard();

  useEffect(() => {
    let alive = true;
    listChannelMembers(channelId)
      .then((m) => alive && setMembers(m))
      .catch(() => alive && setMembers([]));
    return () => {
      alive = false;
    };
  }, [channelId]);

  return (
    <>
      <PopoverPanel placement="down" align="end" className="w-72 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-950/60">
          <Users className="w-3.5 h-3.5 text-content-muted" />
          <span className="text-compact font-medium text-content-secondary">
            Members{members ? ` · ${members.length}` : ""}
          </span>
        </div>

        <ItemList presentationLevel="medium" controlSize="regular" className="max-h-72 overflow-y-auto py-1">
          {members === null ? (
            <OperationsItem title="Loading members…" />
          ) : members.length === 0 ? (
            <OperationsItem title="No members found" />
          ) : (
            members.map((m) => {
              return (
                <MemberRow
                  key={m.member_id}
                  member={m}
                  currentUserId={currentUserId}
                  onOpenProfile={(anchor, member) => {
                    onClose();
                    card?.open(anchor, member);
                  }}
                  onMention={onMention}
                  onStartDm={onStartDm}
                />
              );
            })
          )}
        </ItemList>

        {!isDm && (
          <UiButton action="manage" content="iconText" controlWidth="fill" variant="plain"
            type="button"
            onClick={() => {
              onClose();
              onManage();
            }}
            controlSize="regular" className="flex items-center gap-2  text-content-primary hover:text-content-strong hover:bg-zinc-800 border-t border-zinc-800"
          >
            <Settings className="w-3.5 h-3.5" />
          </UiButton>
        )}
      </PopoverPanel>
    </>
  );
}
