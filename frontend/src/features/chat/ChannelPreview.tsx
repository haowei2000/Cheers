import { useState, type ReactNode } from "react";
import { Hash, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { joinChannel } from "@/api/channels";
import { Button } from "@/components/ui/button";
import type { Channel } from "@/types";
import { useChatStore } from "@/stores/chatStore";
import { ChannelChrome } from "./ChannelChrome";

export function ChannelPreview({
  channel,
  sidebarToggle,
  onBack,
}: {
  channel: Channel;
  sidebarToggle: ReactNode;
  onBack?: () => void;
}) {
  const patchChannel = useChatStore((state) => state.patchChannel);
  const [joining, setJoining] = useState(false);

  async function handleJoin() {
    setJoining(true);
    try {
      await joinChannel(channel.channel_id);
      patchChannel(channel.channel_id, { is_member: true });
      toast.success(`Joined #${channel.name}`);
    } catch {
      toast.error("Couldn't join the channel — please try again");
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <ChannelChrome
        channelId={channel.channel_id}
        title={channel.name}
        isDm={false}
        sidebarToggle={sidebarToggle}
        onBack={onBack}
        actions={null}
      />
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <Hash className="h-5 w-5 text-content-muted" />
        <div className="text-content-primary font-semibold text-comfortable">
          #{channel.name}
        </div>
        {channel.purpose && (
          <p className="text-regular text-content-muted max-w-md">{channel.purpose}</p>
        )}
        <p className="text-regular text-content-muted">
          You&apos;re not a member of this channel yet. Join to read and send messages.
        </p>
        <Button
          action="join"
          type="button"
          onClick={() => void handleJoin()}
          disabled={joining}
          controlSize="regular"
          className="mt-2"
        >
          {joining && <Loader2 className="w-4 h-4 animate-spin" />}
          Join channel
        </Button>
      </div>
    </div>
  );
}
