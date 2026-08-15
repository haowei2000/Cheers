import { Button as UiButton } from "@/components/ui/button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { useState } from "react";
import { Plus, Menu, Radio, Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { useChatStore } from "@/stores/chatStore";
import type { Channel, VoicePresenceSnapshot, Workspace } from "@/types";
import { Avatar } from "@/components/ui/avatar";
import { EntityItem, ItemGroup, ItemRow, ItemSection } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import { controlIconClasses, controlTextClasses } from "@/components/ui/control-size";
import { UnreadBadge } from "@/components/ui/unread-badge";
import { NewDmDialog } from "./NewDmDialog";
import { NewChannelDialog } from "./NewChannelDialog";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

interface SectionProps {
  label: string;
  children: React.ReactNode;
  onAdd?: () => void;
  /** Accessible name for the add (+) control, e.g. "New channel". */
  addLabel?: string;
}

function Section({ label, children, onAdd, addLabel }: SectionProps) {
  return (
    <ItemSection
      label={label}
      presentationLevel="medium"
      controlSize="regular"
      headerControlSize="compact"
      action={onAdd ? (
          <IconButton
            controlSize="compact"
            onClick={onAdd}
            label={addLabel ?? "Add"}
            title={addLabel ?? "Add"}
            className="text-content-primary hover:bg-zinc-700 hover:text-content-strong"
          >
            <Plus className={controlIconClasses.compact} />
          </IconButton>
      ) : undefined}
    >
      {children}
    </ItemSection>
  );
}

interface ChannelItemProps {
  channel: Channel;
  selected: boolean;
  onClick: () => void;
  voicePresence?: VoicePresenceSnapshot;
}

function ChannelItem({ channel, selected, onClick, voicePresence }: ChannelItemProps) {
  const participants = voicePresence?.participants ?? [];
  const unread = (channel.mention_count ?? 0) > 0 ? (
    <UnreadBadge
      title={`${channel.mention_count} unread mention${(channel.mention_count ?? 0) === 1 ? "" : "s"}`}
      aria-label={`${channel.mention_count} unread mention${(channel.mention_count ?? 0) === 1 ? "" : "s"}`}
      tone="mention"
      contentSize="regular"
    >
      @{channel.mention_count}
    </UnreadBadge>
  ) : (channel.unread_count ?? 0) > 0 ? (
    <UnreadBadge contentSize="regular" title={`${channel.unread_count} unread messages`} aria-label={`${channel.unread_count} unread messages`}>
      {channel.unread_count}
    </UnreadBadge>
  ) : null;
  return (
    <ItemGroup>
      <ItemRow
        kind="navigation"
        onClick={onClick}
        selected={selected}
        title={<span className={cn(channel.is_member === false && "opacity-50")}>{channel.name}</span>}
        leading={channel.avatar_url ? (
          <Avatar name={channel.name} src={channel.avatar_url} id={channel.channel_id} size="small" />
        ) : channel.kind === "voice" ? (
          <Radio className="h-4 w-4 flex-shrink-0 opacity-70" />
        ) : (
          <EditorialIcon name="section" contentSize="regular" className="flex-shrink-0 opacity-70" />
        )}
        status={participants.length > 0 ? (
          <span className={cn(controlTextClasses.compact, "tabular-nums text-success-400")}>
            {participants.length}
          </span>
        ) : undefined}
        criticalStatus={unread}
        className="rounded-sm border-0"
      />
      {channel.kind === "voice" && participants.length > 0 && (
        <div className="space-y-1 pb-1 pl-7 pr-1">
          {participants.map((participant) => (
            <EntityItem
              key={participant.user_id}
              containerRole="presentation"
              presentationLevel="minimal"
              controlSize="compact"
              title={participant.display_name}
              leading={<Avatar
                name={participant.display_name}
                src={participant.avatar_url}
                id={participant.user_id}
                size="small"
                online
              />}
              criticalStatus={<span className="sr-only">Online</span>}
              className="border-b-0"
            />
          ))}
        </div>
      )}
    </ItemGroup>
  );
}

interface Props {
  workspace?: Workspace;
  /** Mobile: opens the workspace/nav drawer (renders a hamburger in the header). */
  onOpenNav?: () => void;
  /** Mobile: notified after a channel is picked so the layout can push the chat screen. */
  onChannelSelected?: () => void;
}

export function Sidebar({ workspace, onOpenNav, onChannelSelected }: Props) {
  const {
    channels,
    selectedChannelId,
    selectChannel,
    selectedWorkspaceId,
    voicePresenceByChannel,
  } = useChatStore();
  const [dmOpen, setDmOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [wsSettingsOpen, setWsSettingsOpen] = useState(false);
  // Only team workspaces have a settings panel (the personal workspace isn't managed).
  const canOpenSettings = !!workspace && workspace.kind !== "personal";
  // DMs are consolidated into the personal workspace; team workspaces list only
  // their own channels.
  const isPersonal = workspace?.kind === "personal";

  const publicChannels = channels.filter(
    (c) => c.type !== "dm" && c.type !== "private" && c.kind !== "voice"
  );
  const privateChannels = channels.filter((c) => c.type === "private" && c.kind !== "voice");
  const voiceChannels = channels.filter((c) => c.type !== "dm" && c.kind === "voice");
  const dms = channels.filter((c) => c.type === "dm");

  // Selecting a channel also notifies the mobile layout (push the chat screen).
  const pick = (id: string) => {
    selectChannel(id);
    onChannelSelected?.();
  };

  return (
    <div className="w-60 max-md:w-full max-md:flex-1 max-md:min-w-0 bg-sidebar flex flex-col flex-shrink-0">
      {/* Workspace header. No rule under it: the `mb-1` moat sits outside the
          scrolling list, so the gap persists at any scroll offset. */}
      <div className="flex h-11 flex-shrink-0 items-center px-3">
        {onOpenNav && (
          <UiButton variant="plain"
            onClick={onOpenNav}
            title="Workspaces & navigation"
            aria-label="Open navigation"
            content="icon" controlSize="comfortable" className="-ml-2 mr-1 flex items-center justify-center rounded-sm text-content-primary hover:text-content-strong hover:bg-zinc-800/60 transition-colors flex-shrink-0"
          >
            <Menu className={controlIconClasses.comfortable} />
          </UiButton>
        )}
        <ControlTrigger controlWidth="fill"
          onClick={() => canOpenSettings && setWsSettingsOpen(true)}
          title={canOpenSettings ? "Workspace settings" : undefined}
          controlSize="regular" className="group flex items-center gap-2 rounded-sm transition-colors hover:bg-zinc-800/60"
        >
          <span className="font-utility flex-1 truncate text-left text-regular font-semibold text-content-primary">
            {workspace?.name ?? "Workspace"}
          </span>
          {canOpenSettings && (
            // Gear, not a down-chevron: this opens the settings modal rather than
            // expanding a dropdown beneath the header, so a chevron would lie.
            <Settings className={cn(controlIconClasses.regular, "text-content-muted flex-shrink-0")} />
          )}
        </ControlTrigger>
      </div>

      {/* Channel list */}
      <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-2 max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <Section label="Channels" addLabel="New channel" onAdd={() => setChannelOpen(true)}>
          {publicChannels.map((ch) => (
            <ChannelItem
              key={ch.channel_id}
              channel={ch}
              selected={selectedChannelId === ch.channel_id}
              onClick={() => pick(ch.channel_id)}
            />
          ))}
        </Section>

        {voiceChannels.length > 0 && (
          <Section label="Voice Channels">
            {voiceChannels.map((ch) => (
              <ChannelItem
                key={ch.channel_id}
                channel={ch}
                selected={selectedChannelId === ch.channel_id}
                onClick={() => pick(ch.channel_id)}
                voicePresence={voicePresenceByChannel[ch.channel_id]}
              />
            ))}
          </Section>
        )}

        {privateChannels.length > 0 && (
          <Section label="Private">
            {privateChannels.map((ch) => (
              <ChannelItem
                key={ch.channel_id}
                channel={ch}
                selected={selectedChannelId === ch.channel_id}
                onClick={() => pick(ch.channel_id)}
              />
            ))}
          </Section>
        )}

        {/* Direct messages live only in the personal workspace (the DM home), so
            they aren't duplicated across every team workspace's sidebar. */}
        {isPersonal && (
          <Section label="Direct Messages" addLabel="New direct message" onAdd={() => setDmOpen(true)}>
            {dms.map((ch) => (
              <ItemRow
                key={ch.channel_id}
                onClick={() => pick(ch.channel_id)}
                kind="navigation"
                selected={selectedChannelId === ch.channel_id}
                title={ch.peer_name || ch.name || "Direct Message"}
                leading={<EditorialIcon name="correspondence" contentSize="regular" className="flex-shrink-0 opacity-70" />}
                className="rounded-sm border-0"
              />
            ))}
          </Section>
        )}
      </div>
      {dmOpen && (
        <NewDmDialog onClose={() => setDmOpen(false)} onPicked={onChannelSelected} />
      )}
      {channelOpen && selectedWorkspaceId && (
        <NewChannelDialog
          workspaceId={selectedWorkspaceId}
          onClose={() => setChannelOpen(false)}
          onPicked={onChannelSelected}
        />
      )}
      {wsSettingsOpen && workspace && (
        <WorkspaceSettingsDialog
          workspace={workspace}
          onClose={() => setWsSettingsOpen(false)}
        />
      )}
    </div>
  );
}
