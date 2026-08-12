import { Button as UiButton } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { Users, Bot, Settings } from "lucide-react";
import { listChannelMembers } from "@/api/channels";
import { Avatar } from "@/components/ui/avatar";
import { PopoverPanel } from "@/components/ui/popover";
import { EntityItem, ItemList, OperationsItem } from "@/components/ui/item";
import { useProfileCard } from "./ProfileHovercard";
import type { MemberItem } from "@/types";

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
}: {
  channelId: string;
  isDm: boolean;
  onManage: () => void;
  onClose: () => void;
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
          <Users className="w-3.5 h-3.5 text-zinc-500" />
          <span className="text-compact font-medium text-zinc-300">
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
              const name = m.display_name || m.username || m.member_id.slice(0, 8);
              return (
                <EntityItem
                  key={m.member_id}
                  onClick={(e) => {
                    // Close this popover before opening the hovercard so the two
                    // transient layers never stack (one popover at a time). The
                    // rect is captured synchronously here, so the anchor unmounting
                    // right after is fine — mirrors the "Manage members…" pattern.
                    const anchor = e.currentTarget;
                    onClose();
                    card?.open(anchor, m);
                  }}
                  title={name}
                  leading={<Avatar name={name} src={m.avatar_url ?? undefined} id={m.member_id} size="regular" online={m.is_online ?? undefined} />}
                  status={m.member_type === "bot" ? <Bot className="h-3 w-3 text-indigo-400" /> : undefined}
                  trailing={m.role && m.role !== "member" ? <span className="text-minimal capitalize text-zinc-400">{m.role}</span> : undefined}
                />
              );
            })
          )}
        </ItemList>

        {!isDm && (
          <UiButton controlWidth="fill" variant="plain"
            type="button"
            onClick={() => {
              onClose();
              onManage();
            }}
            controlSize="regular" className="flex items-center gap-2 text-compact text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 border-t border-zinc-800"
          >
            <Settings className="w-3.5 h-3.5" />
            Manage members…
          </UiButton>
        )}
      </PopoverPanel>
    </>
  );
}
