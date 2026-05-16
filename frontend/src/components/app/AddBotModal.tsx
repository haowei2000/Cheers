import { useMemo, useState } from "react";
import type { BotItem, ChannelBot } from "../../types";
import {
  botInlineStatus,
  botOwnerText,
  botScopeText,
  introSummary,
} from "../../lib/bot-display";
import { AppIcon } from "../icons/AppIcon";
import { MemberRow, MemberSection } from "../members";
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
    label.includes("Online") || label.includes("Enabled")
      ? "green"
      : label.includes("partial")
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
      title="Manage channel bots"
      description="Choose bots to join this channel, and view connection status, visibility, and owner."
      maxWidth="max-w-4xl"
      panelClassName="overflow-hidden"
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <section className="min-w-0">
          <div className="max-h-[48vh] overflow-y-auto pr-1">
            <MemberSection
              title={`${channelBots.length} bots in this channel`}
              count={channelBots.length}
              empty={
                <div className="rounded-lg border p-4 text-sm" style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}>
                  No bots. Select one from the list on the right to add it.
                </div>
              }
            >
              {channelBots.map((bot) => (
                <MemberRow
                  key={bot.member_id}
                  as="article"
                  member={{ ...bot, member_type: "bot" }}
                  badge={<StatusChip bot={bot} />}
                  meta={<BotMetaLine bot={bot} />}
                  action={
                    <button
                      type="button"
                      onClick={() => onRemoveBot(bot.member_id)}
                      className="an-btn an-btn-danger an-btn-sm"
                    >
                      Remove
                    </button>
                  }
                />
              ))}
            </MemberSection>
          </div>
        </section>

        <section className="min-w-0">
          <div className="mb-2 flex items-end justify-end gap-3">
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
                  placeholder="Search bots"
                />
              </div>
            </div>
          </div>
          <div className="max-h-[48vh] overflow-y-auto pr-1">
            <MemberSection
              title={`${filteredBots.length}/${availableBots.length} available bots`}
              count={filteredBots.length}
              empty={
                <div className="rounded-lg border p-4 text-sm" style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}>
                  {availableBots.length === 0 ? "No bots available to add." : "No matching bots."}
                </div>
              }
            >
              {filteredBots.map((bot) => {
                const checked = selectedBotIds.has(bot.bot_id);
                const summary = introSummary(bot.intro);
                return (
                  <MemberRow
                    key={bot.bot_id}
                    as="button"
                    onClick={() => onToggleBot(bot.bot_id)}
                    active={checked}
                    member={{ ...bot, member_type: "bot" }}
                    badge={<StatusChip bot={bot} />}
                    meta={
                      <>
                        <BotMetaLine bot={bot} />
                        {summary && (
                          <span className="ml-1" style={{ color: "var(--fg-2)" }}>
                            · {summary}
                          </span>
                        )}
                      </>
                    }
                    leading={
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border" style={{ borderColor: checked ? "var(--accent)" : "var(--border)", color: "var(--accent)" }}>
                        {checked && <AppIcon name="check" className="h-3.5 w-3.5" />}
                      </span>
                    }
                  />
                );
              })}
            </MemberSection>
          </div>
        </section>
      </div>

      <ModalFooter>
        <button type="button" onClick={onClose} className="an-btn an-btn-ghost">
          Close
        </button>
        <button
          type="button"
          disabled={addingBots || selectedBotIds.size === 0}
          onClick={onAddSelected}
          className="an-btn an-btn-primary"
        >
          {addingBots ? "Adding..." : `Add selected (${selectedBotIds.size})`}
        </button>
      </ModalFooter>
    </Modal>
  );
}
