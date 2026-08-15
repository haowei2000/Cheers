import { Bot as BotIcon } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityItem, ItemSection } from "@/components/ui/item";
import { OverflowText } from "@/components/ui/overflow-text";
import { UnreadBadge } from "@/components/ui/unread-badge";
import type { FleetBot } from "@/api/fleet";

function statusText(bot: FleetBot) {
  if (bot.is_disabled) return "Disabled";
  if (!bot.online) return "Offline";
  if (bot.pending_count > 0) return "Waiting approval";
  if (bot.busy_sessions > 0) return "Working";
  return "Idle";
}

export function BotRow({ bot, onSelect }: { bot: FleetBot; onSelect: () => void }) {
  const sessions = bot.busy_sessions + bot.idle_sessions;
  const channels = bot.channels?.map((item) => item.channel_name || "Direct message").join(", ");
  return (
    <EntityItem
      onClick={onSelect}
      title={
        <OverflowText fullText={bot.bot_name} touchDisclosure={false}>
          {bot.bot_name}
        </OverflowText>
      }
      leading={<Avatar name={bot.bot_name} id={bot.bot_id} size="regular" online={bot.online} />}
      subtitle={
        [
          bot.status_emoji && bot.status_text ? `${bot.status_emoji} ${bot.status_text}` : bot.status_text,
          sessions ? `${sessions} session${sessions === 1 ? "" : "s"}` : null,
          channels,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      criticalStatus={
        bot.pending_count > 0 ? (
          <UnreadBadge tone="approval" contentSize="regular">
            {bot.pending_count}
          </UnreadBadge>
        ) : undefined
      }
      status={<span className="text-compact text-zinc-400">{statusText(bot)}</span>}
      trailing={
        <span className="flex items-center gap-2 text-compact text-zinc-400">
          <span>{bot.can_manage ? "Mine" : "Shared"}</span>
          {bot.installation_count ? <span>{bot.installation_count} install.</span> : null}
          {bot.cost_today_usd > 0 ? <span className="tabular-nums">${bot.cost_today_usd.toFixed(2)}</span> : null}
        </span>
      }
    />
  );
}

export function FleetBots({
  bots,
  onOpenBot,
}: {
  bots: FleetBot[];
  onOpenBot: (botId: string) => void;
}) {
  return (
    <ItemSection
      label={`Bots ${bots.length}`}
      description="All bots you own or share a channel with. Workspace and channel are context, not navigation."
      presentationLevel="max"
      controlSize="regular"
    >
      {bots.length ? (
        bots.map((bot) => <BotRow key={bot.bot_id} bot={bot} onSelect={() => onOpenBot(bot.bot_id)} />)
      ) : (
        <EmptyState icon={BotIcon} title="No bots yet" hint="Create a bot, then connect it on the device that will run it." />
      )}
    </ItemSection>
  );
}
