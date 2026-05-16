import toast from "react-hot-toast";
import type { Channel, DM, SearchSelection } from "../types";
import { Modal, ModalFooter } from "./Modal";
import { SearchPicker } from "./SearchPicker";
import { AppIcon } from "./icons/AppIcon";
import { MemberAvatar, type MemberKind } from "./members";

interface ForwardMessageModalProps {
  channels: Channel[];
  dms: DM[];
  open: boolean;
  submitting?: boolean;
  summary: string;
  token?: string | null;
  workspaceId?: string | null;
  onClose: () => void;
  onForwardToChannel: (channelId: string) => Promise<void> | void;
  onForwardToMember: (
    memberId: string,
    memberType: "user" | "bot",
  ) => Promise<void> | void;
}

function channelLabel(channel: Channel): string {
  if (channel.type === "dm") return channel.name || "DM";
  return `#${channel.name}`;
}

function dmLabel(dm: DM): string {
  return (
    dm.counterparty.display_name ||
    dm.counterparty.username ||
    (dm.counterparty.member_type === "bot" ? "Bot" : "User")
  );
}

function dmSubLabel(dm: DM): string {
  if (dm.counterparty.member_type === "bot") return "Bot DMs";
  if (dm.counterparty.username) return `@${dm.counterparty.username}`;
  return "DMs";
}

export function ForwardMessageModal({
  channels,
  dms,
  open,
  submitting = false,
  summary,
  token,
  workspaceId,
  onClose,
  onForwardToChannel,
  onForwardToMember,
}: ForwardMessageModalProps) {
  const visibleChannels = workspaceId
    ? channels.filter((channel) => channel.workspace_id === workspaceId)
    : channels;
  const visibleDMs = dms;

  const handleSearchPick = (selection: SearchSelection) => {
    if (selection.type === "channel") {
      void onForwardToChannel(selection.item.channel_id);
      return;
    }
    if (selection.type === "user") {
      void onForwardToMember(selection.item.user_id, "user");
      return;
    }
    if (selection.type === "bot") {
      void onForwardToMember(selection.item.bot_id, "bot");
      return;
    }
    toast.error("Select a channel, user, or bot");
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => undefined : onClose}
      title="Forward to"
      description={summary}
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        <SearchPicker
          context="global_nav"
          token={token}
          workspaceId={workspaceId}
          modal
          autoFocus
          limit={8}
          placeholder="Search channels, users, or bots"
          emptyText="No forward targets"
          actionLabel={(selection) =>
            selection.type === "channel" ||
            selection.type === "user" ||
            selection.type === "bot"
              ? "Forward"
              : null
          }
          onSelect={handleSearchPick}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="min-w-0">
            <div className="mb-2 text-xs font-semibold text-[var(--fg-3)]">
              Channels
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {visibleChannels.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--fg-3)]">
                  No channels
                </div>
              ) : (
                visibleChannels.map((channel) => (
                  <button
                    key={channel.channel_id}
                    type="button"
                    disabled={submitting}
                    onClick={() => void onForwardToChannel(channel.channel_id)}
                    className="an-row-card w-full"
                  >
                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-[var(--surface-soft)] text-[var(--fg-3)]">
                      <AppIcon name="channel" className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-[var(--fg-1)]">
                        {channelLabel(channel)}
                      </span>
                      <span className="block truncate text-xs text-[var(--fg-3)]">
                        {channel.type === "private" ? "Private" : "Workspace"}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="min-w-0">
            <div className="mb-2 text-xs font-semibold text-[var(--fg-3)]">
              DMs
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {visibleDMs.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--fg-3)]">
                  No DMs
                </div>
              ) : (
                visibleDMs.map((dm) => (
                  <button
                    key={dm.channel_id}
                    type="button"
                    disabled={submitting}
                    onClick={() => void onForwardToChannel(dm.channel_id)}
                    className="an-row-card w-full"
                  >
                    <MemberAvatar
                      avatarUrl={dm.counterparty.avatar_url}
                      kind={dm.counterparty.member_type as MemberKind}
                      label={dmLabel(dm)}
                      size={28}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-[var(--fg-1)]">
                        {dmLabel(dm)}
                      </span>
                      <span className="block truncate text-xs text-[var(--fg-3)]">
                        {dmSubLabel(dm)}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      <ModalFooter>
        <button
          type="button"
          className="an-btn an-btn-ghost"
          disabled={submitting}
          onClick={onClose}
        >
          Cancel
        </button>
      </ModalFooter>
    </Modal>
  );
}
