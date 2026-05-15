import toast from "react-hot-toast";
import type { Channel, DM, SearchSelection } from "../types";
import { Modal, ModalFooter } from "./Modal";
import { SearchPicker } from "./SearchPicker";
import { AppIcon } from "./icons/AppIcon";

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
    (dm.counterparty.member_type === "bot" ? "Bot" : "用户")
  );
}

function dmSubLabel(dm: DM): string {
  if (dm.counterparty.member_type === "bot") return "Bot 私信";
  if (dm.counterparty.username) return `@${dm.counterparty.username}`;
  return "私信";
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
    toast.error("请选择频道、用户或 Bot");
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => undefined : onClose}
      title="转发到"
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
          placeholder="搜索频道、用户或 Bot"
          emptyText="没有可转发的目标"
          actionLabel={(selection) =>
            selection.type === "channel" ||
            selection.type === "user" ||
            selection.type === "bot"
              ? "转发"
              : null
          }
          onSelect={handleSearchPick}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="min-w-0">
            <div className="mb-2 text-xs font-semibold text-[var(--fg-3)]">
              频道
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {visibleChannels.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--fg-3)]">
                  没有频道
                </div>
              ) : (
                visibleChannels.map((channel) => (
                  <button
                    key={channel.channel_id}
                    type="button"
                    disabled={submitting}
                    onClick={() => void onForwardToChannel(channel.channel_id)}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-soft)] disabled:opacity-50"
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
              私信
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {visibleDMs.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--fg-3)]">
                  没有私信
                </div>
              ) : (
                visibleDMs.map((dm) => (
                  <button
                    key={dm.channel_id}
                    type="button"
                    disabled={submitting}
                    onClick={() => void onForwardToChannel(dm.channel_id)}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-soft)] disabled:opacity-50"
                  >
                    {dm.counterparty.avatar_url ? (
                      <img
                        src={dm.counterparty.avatar_url}
                        alt={dmLabel(dm)}
                        className="h-7 w-7 flex-shrink-0 rounded-md object-cover"
                      />
                    ) : (
                      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-[var(--surface-soft)] text-[var(--fg-3)]">
                        <AppIcon
                          name={dm.counterparty.member_type === "bot" ? "bot" : "user"}
                          className="h-4 w-4"
                        />
                      </span>
                    )}
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
          className="rounded-md px-3 py-1.5 text-sm text-[var(--fg-2)] transition-colors hover:bg-[var(--surface-soft)]"
          disabled={submitting}
          onClick={onClose}
        >
          取消
        </button>
      </ModalFooter>
    </Modal>
  );
}
