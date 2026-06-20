import { useState, useCallback, useEffect } from "react";
import { Hash, Users, Loader2 } from "lucide-react";
import { listMessages, sendMessage } from "@/api/messages";
import { MessageList } from "./MessageList";
import { MessageComposer } from "./MessageComposer";
import { useChatRealtime } from "./hooks/useChatRealtime";
import { useAuthStore } from "@/stores/authStore";
import type { Message, Channel } from "@/types";

interface Props {
  channel: Channel | null;
}

function upsertMessage(
  msgs: Message[],
  incoming: Message
): Message[] {
  const idx = msgs.findIndex((m) => m.msg_id === incoming.msg_id);
  if (idx === -1) return [...msgs, incoming];
  return msgs.map((m, i) => (i === idx ? { ...m, ...incoming } : m));
}

export function ChannelView({ channel }: Props) {
  const user = useAuthStore((s) => s.user);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Load initial messages
  useEffect(() => {
    if (!channel) {
      setMessages([]);
      return;
    }
    setLoading(true);
    setMessages([]);
    listMessages(channel.channel_id, { limit: 50 })
      .then((res) => {
        const msgs = (res.messages ?? res.data ?? []).reverse();
        setMessages(msgs);
        setHasMore(res.meta?.has_more_before ?? false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channel?.channel_id]);

  // Load older messages
  const loadMore = useCallback(async () => {
    if (!channel || loadingMore || !hasMore) return;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const res = await listMessages(channel.channel_id, {
        before: oldest.msg_id,
        limit: 50,
      });
      const older = (res.messages ?? res.data ?? []).reverse();
      setMessages((prev) => [...older, ...prev]);
      setHasMore(res.meta?.has_more_before ?? false);
    } finally {
      setLoadingMore(false);
    }
  }, [channel, messages, hasMore, loadingMore]);

  // WebSocket handlers
  const handleMessage = useCallback((msg: Message) => {
    setMessages((prev) => upsertMessage(prev, msg));
  }, []);

  const handleStreamDelta = useCallback((msgId: string, delta: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.msg_id === msgId
          ? { ...m, content: m.content + delta, _streaming: true }
          : m
      )
    );
  }, []);

  const handleStreamDone = useCallback(
    (update: Partial<Message> & { msg_id: string }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.msg_id === update.msg_id
            ? { ...m, ...update, _streaming: false }
            : m
        )
      );
    },
    []
  );

  const handleDeleted = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.msg_id === msgId
          ? { ...m, is_deleted: true, content: "" }
          : m
      )
    );
  }, []);

  useChatRealtime(channel?.channel_id ?? null, {
    onMessage: handleMessage,
    onStreamDelta: handleStreamDelta,
    onStreamDone: handleStreamDone,
    onMessageDeleted: handleDeleted,
  });

  async function handleSend(content: string) {
    if (!channel) return;
    await sendMessage(channel.channel_id, content);
  }

  if (!channel) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm flex-col gap-3">
        <Hash className="w-10 h-10 text-zinc-700" />
        <span>Select a channel to start chatting</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Channel header */}
      <div className="flex items-center gap-3 px-4 h-12 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm flex-shrink-0">
        <Hash className="w-4 h-4 text-zinc-500 flex-shrink-0" />
        <span className="font-semibold text-zinc-100 text-sm">
          {channel.name}
        </span>
        {channel.purpose && (
          <>
            <div className="w-px h-4 bg-zinc-700" />
            <span className="text-xs text-zinc-500 truncate">
              {channel.purpose}
            </span>
          </>
        )}
        <div className="flex-1" />
        <button className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-300 transition-colors text-xs">
          <Users className="w-3.5 h-3.5" />
          Members
        </button>
      </div>

      {/* Messages */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
        </div>
      ) : (
        <MessageList
          messages={messages}
          currentUserId={user?.user_id}
          hasMore={hasMore}
          onLoadMore={loadMore}
          loading={loadingMore}
        />
      )}

      {/* Composer */}
      <MessageComposer
        channelName={channel.name}
        onSend={handleSend}
      />
    </div>
  );
}
