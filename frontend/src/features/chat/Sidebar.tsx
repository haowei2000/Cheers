import { useState } from "react";
import { Hash, ChevronDown, ChevronRight, Plus, Bot } from "lucide-react";
import { cn } from "@/lib/cn";
import { useChatStore } from "@/stores/chatStore";
import type { Channel } from "@/types";

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
        className="w-full flex items-center gap-1 px-2 py-1 text-xs font-semibold text-zinc-500 hover:text-zinc-300 uppercase tracking-wider transition-colors group"
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
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-zinc-700 transition-all cursor-pointer"
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
        "w-full flex items-center gap-2 px-3 py-1 rounded-md text-sm transition-colors text-left",
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
  workspaceName?: string;
}

export function Sidebar({ workspaceName }: Props) {
  const { channels, selectedChannelId, selectChannel } = useChatStore();

  const publicChannels = channels.filter(
    (c) => c.type !== "dm" && c.type !== "private"
  );
  const privateChannels = channels.filter((c) => c.type === "private");

  return (
    <div className="w-60 bg-sidebar flex flex-col border-r border-zinc-800/60 flex-shrink-0">
      {/* Workspace header */}
      <div className="h-12 flex items-center px-3 border-b border-zinc-800/60 flex-shrink-0">
        <button className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-800/60 transition-colors w-full group">
          <span className="font-semibold text-zinc-100 text-sm truncate flex-1 text-left">
            {workspaceName ?? "Workspace"}
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        </button>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto py-3 px-2">
        {publicChannels.length > 0 && (
          <Section label="Channels" onAdd={() => {}}>
            {publicChannels.map((ch) => (
              <ChannelItem
                key={ch.channel_id}
                channel={ch}
                selected={selectedChannelId === ch.channel_id}
                onClick={() => selectChannel(ch.channel_id)}
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
                onClick={() => selectChannel(ch.channel_id)}
              />
            ))}
          </Section>
        )}

        {channels.length === 0 && (
          <div className="px-3 py-4 text-xs text-zinc-600 text-center">
            No channels yet
          </div>
        )}
      </div>
    </div>
  );
}
