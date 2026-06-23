import { useState, useCallback, useEffect, useRef } from "react";
import { Hash, Users, Loader2 } from "lucide-react";
import { listMessages, sendMessage } from "@/api/messages";
import { listChannelMembers } from "@/api/channels";
import { MessageList } from "./MessageList";
import { MessageComposer, type MentionCandidate } from "./MessageComposer";
import { useChatRealtime } from "./hooks/useChatRealtime";
import { useAuthStore } from "@/stores/authStore";
import type { Message, Channel } from "@/types";

// In-flight bot placeholders arrive with `channel_seq: null`; they are the
// newest thing in the channel until finalized, so order them last. Stable sort
// preserves arrival order among equal keys.
const SEQ_MAX = Number.MAX_SAFE_INTEGER;
function seqKey(m: Message): number {
  return typeof m.channel_seq === "number" ? m.channel_seq : SEQ_MAX;
}
function sortMessages(msgs: Message[]): Message[] {
  return [...msgs].sort((a, b) => seqKey(a) - seqKey(b));
}

function upsertMessage(
  msgs: Message[],
  incoming: Partial<Message> & { msg_id: string }
): Message[] {
  const idx = msgs.findIndex((m) => m.msg_id === incoming.msg_id);
  if (idx === -1) return sortMessages([...msgs, incoming as Message]);
  const reorder =
    incoming.channel_seq !== undefined &&
    msgs[idx].channel_seq !== incoming.channel_seq;
  const next = msgs.map((m, i) => (i === idx ? { ...m, ...incoming } : m));
  return reorder ? sortMessages(next) : next;
}

function mergeMessages(msgs: Message[], incoming: Message[]): Message[] {
  let out = msgs;
  for (const m of incoming) out = upsertMessage(out, m);
  return out;
}

interface Props {
  channel: Channel | null;
}

export function ChannelView({ channel }: Props) {
  const user = useAuthStore((s) => s.user);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mentionables, setMentionables] = useState<MentionCandidate[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);

  // Highest delivered channel_seq, used as the reconnect/refresh catch-up cursor.
  const lastSeqRef = useRef(0);
  useEffect(() => {
    let max = 0;
    for (const m of messages) {
      if (typeof m.channel_seq === "number" && m.channel_seq > max)
        max = m.channel_seq;
    }
    lastSeqRef.current = max;
  }, [messages]);

  // Initial history load (backend returns ascending: oldest first).
  useEffect(() => {
    if (!channel) {
      setMessages([]);
      return;
    }
    setLoading(true);
    setMessages([]);
    listMessages(channel.channel_id, { limit: 50 })
      .then((res) => {
        setMessages(sortMessages(res.messages ?? res.data ?? []));
        setHasMore(res.meta?.has_more_before ?? false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channel?.channel_id]);

  // Mention candidates = channel members (users + bots).
  useEffect(() => {
    if (!channel) {
      setMentionables([]);
      return;
    }
    listChannelMembers(channel.channel_id)
      .then((members) =>
        setMentionables(
          members
            .filter((m) => m.member_type === "user" || m.member_type === "bot")
            .map((m) => ({
              id: m.member_id,
              type: m.member_type === "bot" ? "bot" : "user",
              label: m.display_name || m.username || m.member_id.slice(0, 8),
              sublabel: m.username,
            }))
        )
      )
      .catch(() => setMentionables([]));
  }, [channel?.channel_id]);

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
      setMessages((prev) => mergeMessages(prev, res.messages ?? res.data ?? []));
      setHasMore(res.meta?.has_more_before ?? false);
    } finally {
      setLoadingMore(false);
    }
  }, [channel, messages, hasMore, loadingMore]);

  // Reconnect/refresh self-heal: pull everything past our last seq and merge.
  const catchUp = useCallback(async () => {
    if (!channel) return;
    try {
      const res = await listMessages(channel.channel_id, {
        since_seq: lastSeqRef.current,
      });
      const incoming = res.messages ?? res.data ?? [];
      if (incoming.length) setMessages((prev) => mergeMessages(prev, incoming));
    } catch {
      /* best-effort; the live stream still delivers new frames */
    }
  }, [channel]);

  const handleMessage = useCallback((msg: Message) => {
    setMessages((prev) => upsertMessage(prev, msg));
  }, []);

  const handleStreamDelta = useCallback((msgId: string, delta: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.msg_id === msgId);
      if (idx === -1) {
        // Defensive: a delta beat its placeholder bubble — synthesize one.
        return upsertMessage(prev, {
          msg_id: msgId,
          sender_type: "bot",
          content: delta,
          is_partial: true,
          _streaming: true,
        });
      }
      return prev.map((m, i) =>
        i === idx
          ? { ...m, content: (m.content ?? "") + delta, _streaming: true }
          : m
      );
    });
  }, []);

  const handleStreamDone = useCallback(
    (update: Partial<Message> & { msg_id: string }) => {
      setMessages((prev) =>
        upsertMessage(prev, { ...update, _streaming: false, _trace: null })
      );
    },
    []
  );

  const handleBotTrace = useCallback(
    (msgId: string | null, title: string | null) => {
      if (!msgId) return;
      setMessages((prev) => upsertMessage(prev, { msg_id: msgId, _trace: title }));
    },
    []
  );

  const handleDeleted = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.msg_id === msgId ? { ...m, is_deleted: true, content: "" } : m
      )
    );
  }, []);

  useChatRealtime(channel?.channel_id ?? null, {
    onMessage: handleMessage,
    onStreamDelta: handleStreamDelta,
    onStreamDone: handleStreamDone,
    onMessageDeleted: handleDeleted,
    onReady: catchUp,
    onPresence: (_ids, count) => setOnlineCount(count),
    onBotTrace: handleBotTrace,
  });

  async function handleSend(
    content: string,
    mentionIds: string[],
    fileIds: string[]
  ) {
    if (!channel) return;
    await sendMessage(channel.channel_id, content, {
      ...(mentionIds.length ? { mention_ids: mentionIds } : {}),
      ...(fileIds.length ? { file_ids: fileIds } : {}),
    });
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
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          {onlineCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {onlineCount} online
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" />
            {mentionables.length || "Members"}
          </span>
        </div>
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
        channelId={channel.channel_id}
        channelName={channel.name}
        mentionables={mentionables}
        onSend={handleSend}
      />
    </div>
  );
}
