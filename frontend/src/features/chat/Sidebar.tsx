import { useState } from "react";
import { Hash, ChevronDown, ChevronRight, Plus, MessageSquare, Menu } from "lucide-react";
import { cn } from "@/lib/cn";
import { useChatStore } from "@/stores/chatStore";
import type { Channel, Workspace } from "@/types";
import { NewDmDialog } from "./NewDmDialog";
import { NewChannelDialog } from "./NewChannelDialog";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

interface SectionProps {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  onAdd?: () => void;
}

function Section({ label, children, defaultOpen = true, onAdd }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-1 max-md:py-2 text-xs font-semibold text-zinc-500 hover:text-zinc-300 uppercase tracking-wider transition-colors group"
      >
        {open ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <span className="flex-1 text-left">{label}</span>
        {onAdd && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            title="Add"
            // Hover-revealed on desktop; always visible (with a bigger tap area) on touch.
            className="opacity-0 group-hover:opacity-100 max-md:opacity-100 p-0.5 max-md:p-1.5 max-md:-my-1 rounded hover:bg-zinc-700 transition-all cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </span>
        )}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

interface ChannelItemProps {
  channel: Channel;
  selected: boolean;
  onClick: () => void;
}

function ChannelItem({ channel, selected, onClick }: ChannelItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        // max-md:py-3 → ~44px touch rows on phones; desktop keeps the compact py-1.
        "w-full flex items-center gap-2 px-3 py-1 max-md:py-3 rounded-md text-sm transition-colors text-left",
        selected
          ? "bg-zinc-700/70 text-zinc-50 font-medium"
          : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
      )}
    >
      <Hash className="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
      <span className="truncate">{channel.name}</span>
      {(channel.unread_count ?? 0) > 0 && (
        <span className="ml-auto text-[10px] font-bold bg-indigo-600 text-white rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
          {channel.unread_count}
        </span>
      )}
    </button>
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
  const { channels, selectedChannelId, selectChannel, selectedWorkspaceId } =
    useChatStore();
  const [dmOpen, setDmOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [wsSettingsOpen, setWsSettingsOpen] = useState(false);
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

  return (
    <div className="w-60 max-md:w-full max-md:flex-1 max-md:min-w-0 bg-sidebar flex flex-col border-r max-md:border-r-0 border-zinc-800/60 flex-shrink-0">
      {/* Workspace header */}
      <div className="h-12 flex items-center px-3 border-b border-zinc-800/60 flex-shrink-0">
        {onOpenNav && (
          <button
            onClick={onOpenNav}
            title="Workspaces & navigation"
            aria-label="Open navigation"
            className="w-11 h-11 -ml-2 mr-0.5 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors flex-shrink-0"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}
        <button
          onClick={() => canOpenSettings && setWsSettingsOpen(true)}
          title={canOpenSettings ? "Workspace settings" : undefined}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-800/60 transition-colors w-full group"
        >
          <span className="font-semibold text-zinc-100 text-sm truncate flex-1 text-left">
            {workspace?.name ?? "Workspace"}
          </span>
          {canOpenSettings && (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
          )}
        </button>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto overscroll-contain py-3 px-2 max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <Section label="Channels" onAdd={() => setChannelOpen(true)}>
          {publicChannels.map((ch) => (
            <ChannelItem
              key={ch.channel_id}
              channel={ch}
              selected={selectedChannelId === ch.channel_id}
              onClick={() => pick(ch.channel_id)}
            />
          ))}
        </Section>

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
          <Section label="Direct Messages" onAdd={() => setDmOpen(true)}>
            {dms.map((ch) => (
              <button
                key={ch.channel_id}
                onClick={() => pick(ch.channel_id)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1 max-md:py-3 rounded-md text-sm transition-colors text-left",
                  selectedChannelId === ch.channel_id
                    ? "bg-zinc-700/70 text-zinc-50 font-medium"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                )}
              >
                <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
                <span className="truncate">{ch.peer_name || ch.name || "Direct Message"}</span>
              </button>
            ))}
            {dms.length === 0 && (
              <div className="px-3 py-1 text-xs text-zinc-600">Click + to start a direct message</div>
            )}
          </Section>
        )}

        {channels.length === 0 && (
          <div className="px-3 py-4 text-xs text-zinc-600 text-center">
            No channels yet
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
