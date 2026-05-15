import { useMemo, useState } from "react";
import type { BotItem, ChannelBot } from "../../types";
import {
  botInlineStatus,
  botOwnerText,
  botScopeText,
  introSummary,
} from "../../lib/bot-display";
import { AppIcon } from "../icons/AppIcon";
import { MemberListItem } from "../members";
import { Modal, ModalFooter } from "../Modal";

interface AddBotModalProps {
  addingBots: boolean;
  allBots: BotItem[];
  channelBots: ChannelBot[];
  onAddSelected: () => Promise<void> | void;
  onClose: () => void;
  onRemoveBot: (memberId: string) => void;
  onToggleBot: (botId: string) => void;
  open: boolean;
  selectedBotIds: Set<string>;
  selectedChannelId: string | null;
}

function BotMetaLine({ bot }: { bot: Pick<BotItem, "owner" | "scope"> }) {
  return (
    <span>
      {botScopeText(bot.scope)} · Owner: {botOwnerText(bot)}
    </span>
  );
}

function StatusChip({
  bot,
}: {
  bot: Pick<BotItem, "binding_type" | "connection_status" | "is_online" | "status">;
}) {
  const label = botInlineStatus(bot);
  const tone =
    label.includes("在线") || label.includes("启用")
      ? "green"
      : label.includes("部分")
        ? "orange"
        : "";
  return <span className={`an-chip ${tone}`}>{label}</span>;
}

export function AddBotModal({
  addingBots,
  allBots,
  channelBots,
  onAddSelected,
  onClose,
  onRemoveBot,
  onToggleBot,
  open,
  selectedBotIds,
  selectedChannelId,
}: AddBotModalProps) {
  const [query, setQuery] = useState("");
  const inChannelIds = useMemo(
    () => new Set(channelBots.map((bot) => bot.member_id)),
    [channelBots],
  );
  const availableBots = useMemo(
    () => allBots.filter((bot) => !inChannelIds.has(bot.bot_id)),
    [allBots, inChannelIds],
  );
  const filteredBots = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return availableBots;
    return availableBots.filter((bot) => {
      const haystack = [
        bot.username,
        bot.display_name,
        bot.intro,
        bot.owner?.username,
        bot.owner?.display_name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [availableBots, query]);

  return (
    <Modal
      open={open && Boolean(selectedChannelId)}
      onClose={onClose}
      title="管理频道 Bot"
      description="选择要加入频道协作的 Bot，并查看连接状态、可见范围和所有者。"
      maxWidth="max-w-4xl"
      panelClassName="overflow-hidden"
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <section className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--fg-3)" }}>
                已加入
              </h3>
              <p className="mt-1 text-xs" style={{ color: "var(--fg-3)" }}>
                {channelBots.length} 个 Bot 在此频道
              </p>
            </div>
            <span className="an-chip accent">{channelBots.length}</span>
          </div>
          <div className="max-h-[48vh] space-y-2 overflow-y-auto pr-1">
            {channelBots.length === 0 ? (
              <div className="rounded-lg border p-4 text-sm" style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}>
                暂无 Bot。可以从右侧列表选择并加入。
              </div>
            ) : (
              channelBots.map((bot) => (
                <MemberListItem
                  key={bot.member_id}
                  id={bot.member_id}
                  kind="bot"
                  username={bot.username}
                  displayName={bot.display_name || bot.username}
                  avatarUrl={bot.avatar_url}
                  variant="card"
                  meta={<BotMetaLine bot={bot} />}
                  badges={<StatusChip bot={bot} />}
                  actions={
                    <button
                      type="button"
                      onClick={() => onRemoveBot(bot.member_id)}
                      className="an-btn an-btn-danger an-btn-sm"
                    >
                      移除
                    </button>
                  }
                />
              ))
            )}
          </div>
        </section>

        <section className="min-w-0">
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--fg-3)" }}>
                可添加
              </h3>
              <p className="mt-1 text-xs" style={{ color: "var(--fg-3)" }}>
                {filteredBots.length}/{availableBots.length} 个可用 Bot
              </p>
            </div>
            <div className="an-field m-0 w-48 max-w-[55%]">
              <div className="relative">
                <AppIcon
                  name="search"
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                  style={{ color: "var(--fg-3)" }}
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="an-input h-8 pl-8 text-xs"
                  placeholder="搜索 Bot"
                />
              </div>
            </div>
          </div>
          <div className="max-h-[48vh] space-y-2 overflow-y-auto pr-1">
            {filteredBots.length === 0 ? (
              <div className="rounded-lg border p-4 text-sm" style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}>
                {availableBots.length === 0 ? "暂无可添加 Bot。" : "没有匹配的 Bot。"}
              </div>
            ) : (
              filteredBots.map((bot) => {
                const checked = selectedBotIds.has(bot.bot_id);
                const summary = introSummary(bot.intro);
                return (
                  <MemberListItem
                    key={bot.bot_id}
                    id={bot.bot_id}
                    kind="bot"
                    username={bot.username}
                    displayName={bot.display_name || bot.username}
                    avatarUrl={bot.avatar_url}
                    variant="card"
                    selected={checked}
                    asButton
                    onClick={() => onToggleBot(bot.bot_id)}
                    leading={
                      <span
                        className="mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border"
                        style={{
                          borderColor: checked ? "var(--accent)" : "var(--border)",
                          color: "var(--accent)",
                        }}
                      >
                        {checked && <AppIcon name="check" className="h-3.5 w-3.5" />}
                      </span>
                    }
                    meta={<BotMetaLine bot={bot} />}
                    badges={<StatusChip bot={bot} />}
                  >
                    {summary && (
                      <span className="block truncate text-xs" style={{ color: "var(--fg-2)" }}>
                        {summary}
                      </span>
                    )}
                  </MemberListItem>
                );
              })
            )}
          </div>
        </section>
      </div>

      <ModalFooter>
        <button type="button" onClick={onClose} className="an-btn an-btn-ghost">
          关闭
        </button>
        <button
          type="button"
          disabled={addingBots || selectedBotIds.size === 0}
          onClick={onAddSelected}
          className="an-btn an-btn-primary"
        >
          {addingBots ? "添加中…" : `添加选中 (${selectedBotIds.size})`}
        </button>
      </ModalFooter>
    </Modal>
  );
}
