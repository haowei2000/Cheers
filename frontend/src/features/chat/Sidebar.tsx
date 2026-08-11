import { Button as UiButton } from "@/components/ui/button";
import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Menu, Radio, Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { useChatStore } from "@/stores/chatStore";
import type { Channel, VoicePresenceSnapshot, Workspace } from "@/types";
import { Avatar } from "@/components/ui/avatar";
import { EntityItem, ItemRow } from "@/components/ui/item";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import { controlMinHeightClasses, controlSquareClasses } from "@/components/ui/control-size";
import { NewDmDialog } from "./NewDmDialog";
import { NewChannelDialog } from "./NewChannelDialog";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

interface SectionProps {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  onAdd?: () => void;
  /** Accessible name for the add (+) control, e.g. "New channel". */
  addLabel?: string;
}

// Persist each section's collapsed/expanded choice per label, mirroring the
// existing "cheers.sidebar.open" pattern, so the state survives reloads and the
// mobile Sidebar remount when returning from a conversation.
const SECTION_STATE_PREFIX = "cheers.sidebar.section.";

function Section({ label, children, defaultOpen = true, onAdd, addLabel }: SectionProps) {
  const storageKey = SECTION_STATE_PREFIX + label;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? defaultOpen : stored === "1";
    } catch {
      return defaultOpen;
    }
  });

  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // Storage unavailable (private mode / quota) — keep the in-memory state.
      }
      return next;
    });

  return (
    <div className="space-y-1">
      {/* Two sibling buttons (not a span nested in the toggle) so the add control
          is its own focusable, keyboard-reachable button with valid ARIA. */}
      <div className={cn("group flex items-center gap-1 px-1", controlMinHeightClasses.compact)}>
        <UiButton variant="plain"
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn("font-utility flex flex-1 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-400 transition-colors hover:text-zinc-200", controlMinHeightClasses.compact)}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <span className="flex-1 text-left">{label}</span>
        </UiButton>
        {onAdd && (
          <UiButton variant="plain"
            type="button"
            onClick={onAdd}
            aria-label={addLabel ?? "Add"}
            title={addLabel ?? "Add"}
            // Hover-revealed on desktop, revealed on keyboard focus too, and always
            // visible (with a bigger tap area) on touch.
            className={cn("flex items-center justify-center rounded-sm text-zinc-400 opacity-0 transition-all hover:bg-zinc-700 hover:text-zinc-200 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 group-hover:opacity-100 max-md:opacity-100", controlSquareClasses.compact)}
          >
            <Plus className="w-3.5 h-3.5" />
          </UiButton>
        )}
      </div>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
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
    <span
      title={`${channel.mention_count} unread mention${(channel.mention_count ?? 0) === 1 ? "" : "s"}`}
      className="text-[10px] font-bold bg-rose-600 text-white rounded-full px-1.5 py-0.5 min-w-[18px] text-center"
    >
      @{channel.mention_count}
    </span>
  ) : (channel.unread_count ?? 0) > 0 ? (
    <span className="text-[10px] font-bold bg-indigo-600 text-white rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
      {channel.unread_count}
    </span>
  ) : null;
  return (
    <div>
      <ItemRow
        kind="navigation"
        onClick={onClick}
        selected={selected}
        title={<span className={cn(channel.is_member === false && "opacity-50")}>{channel.name}</span>}
        leading={channel.avatar_url ? (
          <Avatar name={channel.name} src={channel.avatar_url} id={channel.channel_id} size="xs" />
        ) : channel.kind === "voice" ? (
          <Radio className="h-4 w-4 flex-shrink-0 opacity-70" />
        ) : (
          <EditorialIcon name="section" className="h-4 w-4 flex-shrink-0 opacity-70" />
        )}
        status={participants.length > 0 ? (
          <span className="text-[10px] tabular-nums text-emerald-400">
            {participants.length}
          </span>
        ) : undefined}
        criticalStatus={unread}
        className="rounded-sm border-0 px-1"
      />
      {channel.kind === "voice" && participants.length > 0 && (
        <div className="space-y-0.5 pb-1 pl-7 pr-1">
          {participants.map((participant) => (
            <EntityItem
              key={participant.user_id}
              presentationLevel="minimal"
              controlSize="compact"
              title={participant.display_name}
              leading={<Avatar
                name={participant.display_name}
                src={participant.avatar_url}
                id={participant.user_id}
                size="xs"
                online
              />}
              criticalStatus={<span className="sr-only">Online</span>}
              className="border-b-0 px-1 text-xs"
            />
          ))}
        </div>
      )}
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
      <div className="flex h-12 flex-shrink-0 items-center px-3">
        {onOpenNav && (
          <UiButton variant="plain"
            onClick={onOpenNav}
            title="Workspaces & navigation"
            aria-label="Open navigation"
            square controlSize="comfortable" className="-ml-2 mr-0.5 flex items-center justify-center rounded-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors flex-shrink-0"
          >
            <Menu className="w-5 h-5" />
          </UiButton>
        )}
        <UiButton variant="plain"
          onClick={() => canOpenSettings && setWsSettingsOpen(true)}
          title={canOpenSettings ? "Workspace settings" : undefined}
          controlSize="regular" className="group flex w-full items-center gap-2 rounded-sm px-1 transition-colors hover:bg-zinc-800/60"
        >
          <span className="font-utility flex-1 truncate text-left text-sm font-semibold text-zinc-100">
            {workspace?.name ?? "Workspace"}
          </span>
          {canOpenSettings && (
            // Gear, not a down-chevron: this opens the settings modal rather than
            // expanding a dropdown beneath the header, so a chevron would lie.
            <Settings className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
          )}
        </UiButton>
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
          <Section label="Voice Channels" defaultOpen>
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
          <Section label="Private" defaultOpen>
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
                leading={<EditorialIcon name="correspondence" className="h-4 w-4 flex-shrink-0 opacity-70" />}
                className="rounded-sm border-0 px-1"
              />
            ))}
            {dms.length === 0 && (
              <div className="px-3 py-1 text-xs text-zinc-400">Click + to start a direct message</div>
            )}
          </Section>
        )}

        {channels.length === 0 && (
          <div className="px-3 py-4 text-center">
            <p className="text-xs text-zinc-400">No channels yet</p>
            <UiButton variant="plain"
              type="button"
              onClick={() => setChannelOpen(true)}
              className="mt-1 text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Create a channel
            </UiButton>
          </div>
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
