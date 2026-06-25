import { useState, useCallback, useEffect, useRef } from "react";
import { Hash, Users, Loader2, PanelRight, Paperclip, FolderTree } from "lucide-react";
import { listMessages, sendMessage } from "@/api/messages";
import { listChannelMembers } from "@/api/channels";
import { MessageList } from "./MessageList";
import { MessageComposer, type MentionCandidate } from "./MessageComposer";
import { useChatRealtime } from "./hooks/useChatRealtime";
import { WorkbenchDrawer } from "./workbench/WorkbenchDrawer";
import { ErrorDialog } from "@/components/ui/ErrorDialog";
import { ChannelFilesDialog } from "./ChannelFilesDialog";
import { RemoteWorkspaceDialog } from "./RemoteWorkspaceDialog";
import { ResolveRefContext, type RefClick } from "./workspaceLink";
import { resolveRef, getWorkspaceFile } from "@/api/workspace";
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

  const { sendResourceReq } = useChatRealtime(channel?.channel_id ?? null, {
    onMessage: handleMessage,
    onStreamDelta: handleStreamDelta,
    onStreamDone: handleStreamDone,
    onMessageDeleted: handleDeleted,
    onReady: catchUp,
    onPresence: (_ids, count) => setOnlineCount(count),
    onBotTrace: handleBotTrace,
  });
  const [wbOpen, setWbOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [wsInit, setWsInit] = useState<{ botId?: string; path?: string }>({});
  const [filesFocus, setFilesFocus] = useState<string | undefined>(undefined);
  const [wbTarget, setWbTarget] = useState<string | undefined>(undefined);
  const [refError, setRefError] = useState<string | null>(null);

  // Resolve a clicked file reference by PROVENANCE and TAKE THE USER TO where it
  // lives — the channel files view (inbox), the workbench File panel (desk), or the
  // workspace browser — instead of a silent download. Never assumes the bot followed
  // a convention; degrades to a clear error popup (not a 404) when it resolves to nothing.
  const resolveAndOpenRef = useCallback(
    async ({ senderBotId, ref, files }: RefClick) => {
      if (!channel) return;
      const base = ref.split("/").pop() || ref;
      const openInbox = (fileId: string) => {
        setFilesFocus(fileId);
        setFilesOpen(true);
      };
      // 1) Strongest signal: a file THIS message attached (an inbox deliverable).
      const hit = (files || []).find((f) => (f.original_filename || "") === base);
      if (hit) {
        openInbox(hit.file_id);
        return;
      }
      try {
        const r = await resolveRef(channel.channel_id, ref, senderBotId);
        if (r.store === "inbox" && r.file_id) {
          openInbox(r.file_id);
        } else if (r.store === "desk" && r.path) {
          setWbTarget(r.path);
          setWbOpen(true);
        } else if (r.store === "workspace" && r.bot_id && r.path) {
          // The workspace candidate is unprobed — verify the file actually exists on
          // the bot's machine before dropping the user into the browser. If it
          // doesn't, it lives nowhere we can reach → clear error, not a broken view.
          try {
            await getWorkspaceFile(channel.channel_id, r.bot_id, r.path);
            setWsInit({ botId: r.bot_id, path: r.path });
            setWsOpen(true);
          } catch (e) {
            const offline = String(e).includes("offline");
            setRefError(
              offline
                ? `打不开「${base}」:这个文件在 bot「${senderBotId}」的机器上,但它的连接器当前不在线,暂时取不到。`
                : `没找到「${base}」。\n它不在这条回复的附件、频道 Desk,工作区里也没有这个文件——bot 可能只是提到了它,并没有真的产出或分享。`
            );
          }
        } else {
          setRefError(
            `没找到「${base}」。\n它不在这条回复的附件里,也不在频道的 Desk,更不在可达的工作区里——bot 可能提到了这个文件,但并没有真的产出或分享它。`
          );
        }
      } catch (e) {
        setRefError(`打开「${base}」失败:${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [channel]
  );

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
        {/* Channel files (chat attachments) — its own view, separate from the Workbench. */}
        <button
          onClick={() => {
            setFilesFocus(undefined);
            setFilesOpen(true);
          }}
          title="频道文件"
          className="flex items-center justify-center w-7 h-7 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"
        >
          <Paperclip className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            setWsInit({});
            setWsOpen(true);
          }}
          title="远程工作区"
          className="flex items-center justify-center w-7 h-7 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"
        >
          <FolderTree className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            setWbTarget(undefined);
            setWbOpen(true);
          }}
          title="Workbench"
          className="flex items-center justify-center w-7 h-7 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"
        >
          <PanelRight className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
        </div>
      ) : (
        <ResolveRefContext.Provider value={resolveAndOpenRef}>
          <MessageList
            messages={messages}
            currentUserId={user?.user_id}
            hasMore={hasMore}
            onLoadMore={loadMore}
            loading={loadingMore}
          />
        </ResolveRefContext.Provider>
      )}

      {/* Composer */}
      <MessageComposer
        channelId={channel.channel_id}
        channelName={channel.name}
        mentionables={mentionables}
        onSend={handleSend}
      />

      <WorkbenchDrawer
        open={wbOpen}
        onClose={() => setWbOpen(false)}
        channelId={channel.channel_id}
        sendResourceReq={sendResourceReq}
        openFilePath={wbTarget}
      />
      {filesOpen && (
        <ChannelFilesDialog
          channelId={channel.channel_id}
          onClose={() => setFilesOpen(false)}
          focusFileId={filesFocus}
        />
      )}
      {refError && <ErrorDialog message={refError} onClose={() => setRefError(null)} />}
      {wsOpen && (
        <RemoteWorkspaceDialog
          channelId={channel.channel_id}
          onClose={() => setWsOpen(false)}
          initialBotId={wsInit.botId}
          initialPath={wsInit.path}
        />
      )}
    </div>
  );
}
