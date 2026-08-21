import { Button as UiButton } from "@/components/ui/button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { useRef, useState } from "react";
import { FolderOpen, LogOut, Plus, Menu, Radio, Settings } from "lucide-react";
import toast from "react-hot-toast";
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
import { useShallow } from "zustand/react/shallow";
import { CHANNEL_FEATURE_VOICE, hasChannelFeature } from "./channelFeatures";
import { useContextSurface, type ContextAction } from "@/components/ui/context-actions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { leaveChannel } from "@/api/channels";

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
  onSettings?: () => void;
  onLeave?: () => void;
}

function ChannelItem({ channel, selected, onClick, voicePresence, onSettings, onLeave }: ChannelItemProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const voiceEnabled = hasChannelFeature(channel, CHANNEL_FEATURE_VOICE);
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
  const contextSurface = useContextSurface({
    surfaceRef,
    actions: () => [
      { id: "open", label: "Open", icon: <FolderOpen className="h-4 w-4" />, run: onClick },
      ...(onSettings ? [{ id: "settings", label: "Channel settings", icon: <Settings className="h-4 w-4" />, group: "secondary", run: onSettings } satisfies ContextAction] : []),
      ...(onLeave ? [{ id: "leave", label: "Leave channel", icon: <LogOut className="h-4 w-4" />, group: "danger", run: onLeave } satisfies ContextAction] : []),
    ],
  });
  return (
    // Context-menu gestures are delegated to the semantic ItemRow button.
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
      <ItemGroup>
      <ItemRow
        kind="navigation"
        onClick={onClick}
        selected={selected}
        title={<span className={cn(channel.is_member === false && "opacity-50")}>{channel.name}</span>}
        leading={channel.avatar_url ? (
          <Avatar name={channel.name} src={channel.avatar_url} id={channel.channel_id} size="small" />
        ) : (
          <EditorialIcon
            name={channel.type === "dm" ? "correspondence" : "section"}
            contentSize="regular"
            className="flex-shrink-0 opacity-70"
          />
        )}
        status={voiceEnabled ? (
          <span className={cn(controlTextClasses.compact, "inline-flex items-center gap-1 tabular-nums", participants.length > 0 ? "text-success-400" : "text-content-muted")}>
            <Radio className="h-3.5 w-3.5" />
            {participants.length > 0 ? participants.length : null}
          </span>
        ) : undefined}
        criticalStatus={unread}
        className="rounded-sm border-0"
      />
      {voiceEnabled && participants.length > 0 && (
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
    </div>
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
    setChannels,
    requestChannelSettings,
  } = useChatStore(
    useShallow((state) => ({
      channels: state.channels,
      selectedChannelId: state.selectedChannelId,
      selectChannel: state.selectChannel,
      selectedWorkspaceId: state.selectedWorkspaceId,
      voicePresenceByChannel: state.voicePresenceByChannel,
      setChannels: state.setChannels,
      requestChannelSettings: state.requestChannelSettings,
    })),
  );
  const [dmOpen, setDmOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [wsSettingsOpen, setWsSettingsOpen] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<Channel | null>(null);
  const [leaving, setLeaving] = useState(false);
  // Only team workspaces have a settings panel (the personal workspace isn't managed).
  const canOpenSettings = !!workspace && workspace.kind !== "personal";
  // DMs are consolidated into the personal workspace; team workspaces list only
  // their own channels.
  const isPersonal = workspace?.kind === "personal";

  const publicChannels = channels.filter(
    (c) => c.type !== "dm" && c.type !== "private"
  );
  const privateChannels = channels.filter((c) => c.type === "private");
  const dms = channels.filter((c) => c.type === "dm");

  // Selecting a channel also notifies the mobile layout (push the chat screen).
  const pick = (id: string) => {
    selectChannel(id);
    onChannelSelected?.();
  };
  const openSettings = (channel: Channel) => {
    pick(channel.channel_id);
    requestChannelSettings(channel.channel_id);
  };
  const confirmLeave = async () => {
    if (!leaveTarget) return;
    setLeaving(true);
    try {
      await leaveChannel(leaveTarget.channel_id);
      setChannels(channels.filter((channel) => channel.channel_id !== leaveTarget.channel_id));
      if (selectedChannelId === leaveTarget.channel_id) selectChannel(null);
      toast.success(`Left ${leaveTarget.name}`);
      setLeaveTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to leave channel");
    } finally {
      setLeaving(false);
    }
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
              voicePresence={voicePresenceByChannel[ch.channel_id]}
              onSettings={() => openSettings(ch)}
              onLeave={ch.is_member === false ? undefined : () => setLeaveTarget(ch)}
            />
          ))}
        </Section>

        {privateChannels.length > 0 && (
          <Section label="Private">
            {privateChannels.map((ch) => (
              <ChannelItem
                key={ch.channel_id}
                channel={ch}
                selected={selectedChannelId === ch.channel_id}
                onClick={() => pick(ch.channel_id)}
                voicePresence={voicePresenceByChannel[ch.channel_id]}
                onSettings={() => openSettings(ch)}
                onLeave={() => setLeaveTarget(ch)}
              />
            ))}
          </Section>
        )}

        {/* Direct messages live only in the personal workspace (the DM home), so
            they aren't duplicated across every team workspace's sidebar. */}
        {isPersonal && (
          <Section label="Direct Messages" addLabel="New direct message" onAdd={() => setDmOpen(true)}>
            {dms.map((ch) => (
              <ChannelItem
                key={ch.channel_id}
                channel={{ ...ch, name: ch.peer_name || ch.name || "Direct Message" }}
                selected={selectedChannelId === ch.channel_id}
                onClick={() => pick(ch.channel_id)}
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
      {leaveTarget && (
        <ConfirmDialog
          title="Leave channel?"
          confirmAction="leave"
          confirmLabel="Leave channel"
          busy={leaving}
          onConfirm={() => void confirmLeave()}
          onClose={() => !leaving && setLeaveTarget(null)}
        >
          You will leave <strong className="text-content-primary">{leaveTarget.name}</strong> and it will be removed from this sidebar.
        </ConfirmDialog>
      )}
    </div>
  );
}
