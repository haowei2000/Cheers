import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import toast from "react-hot-toast";
import { listMessages } from "@/api/messages";
import { markChannelRead } from "@/api/channels";
import type { Channel, Message, PermissionContentData, TraceEvent } from "@/types";
import { setChannelCache, seedFromCache } from "../chatCache";
import { coalesceTraceEvents } from "../traceEvent";
import { mergeMessages, sortMessages, upsertMessage } from "../messageCollection";

export function useChannelMessages({
  channel,
  preview,
  activeChannelRef,
  patchChannel,
  onPermissionResolved,
}: {
  channel: Channel | null;
  preview: boolean;
  activeChannelRef: MutableRefObject<string | null>;
  patchChannel: (channelId: string, patch: Partial<Channel>) => void;
  onPermissionResolved: () => void;
}) {
  const isPreview = preview;
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

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

  // The channel whose async responses are still welcome — a response landing
  // after a switch must be dropped, not merged into the new channel's state.
  // Which channel the `messages` state currently belongs to. Set inside the
  // setMessages updater (it runs with the commit that applies the seed), so the
  // cache write-back effect can never attribute one channel's rows to another
  // during the one commit where `channel` has switched but `messages` hasn't.
  const msgsOwnerRef = useRef<string | null>(null);
  // `loading` mirrored for stable callbacks (handleReady's catch-up dedup).
  const loadingRef = useRef(false);
  const pendingCatchUpRef = useRef(false);
  const catchUpInFlightRef = useRef(false);
  // A catch-up requested while one is already in flight used to be silently
  // dropped with no retry — if that request was healing the only gap covering
  // a message (e.g. a resubscribe racing a reconnect), the message could stay
  // permanently missing even though it persisted server-side (#330). Coalesce
  // instead: remember the latest overlapping request and run exactly one more
  // pass (with the freshest cursor) right after the in-flight one finishes.
  const catchUpPendingRef = useRef(false);
  const catchUpPendingSinceRef = useRef<number | undefined>(undefined);

  // Reconnect/refresh self-heal: pull everything past our last seq and merge.
  // `sinceSeq` overrides the ref when the caller just seeded state (the ref
  // effect above only updates after that commit).
  const catchUp = useCallback(
    async (sinceSeq?: number) => {
      if (!channel) return;
      if (catchUpInFlightRef.current) {
        catchUpPendingRef.current = true;
        catchUpPendingSinceRef.current = sinceSeq;
        return;
      }
      const cid = channel.channel_id;
      catchUpInFlightRef.current = true;
      try {
        const res = await listMessages(cid, {
          since_seq: sinceSeq ?? lastSeqRef.current,
        });
        if (activeChannelRef.current !== cid) return;
        const incoming = res.messages ?? res.data ?? [];
        if (incoming.length)
          setMessages((prev) => mergeMessages(prev, incoming));
      } catch {
        /* best-effort; the live stream still delivers new frames */
      } finally {
        catchUpInFlightRef.current = false;
        if (catchUpPendingRef.current) {
          catchUpPendingRef.current = false;
          const rerunSince = catchUpPendingSinceRef.current;
          catchUpPendingSinceRef.current = undefined;
          void catchUp(rerunSince);
        }
      }
    },
    [activeChannelRef, channel],
  );

  // Initial history load (backend returns ascending: oldest first). Warm path:
  // re-entering a cached channel seeds instantly from memory (Telegram-style),
  // then a since-seq catch-up merges anything that landed while we were away.
  // Cold path: fetch the newest page; a failure sets loadError so the render
  // shows a retryable error region instead of the "No messages yet" empty state
  // (a failed fetch must not masquerade as empty).
  const loadHistory = useCallback(() => {
    if (!channel || isPreview) return;
    const cid = channel.channel_id;
    setLoadError(false);
    pendingCatchUpRef.current = false;

    const seeded = seedFromCache(cid);
    if (seeded) {
      let maxSeq = 0;
      for (const m of seeded.messages) {
        if (typeof m.channel_seq === "number" && m.channel_seq > maxSeq)
          maxSeq = m.channel_seq;
      }
      lastSeqRef.current = maxSeq;
      setLoading(false);
      loadingRef.current = false;
      setMessages(() => {
        msgsOwnerRef.current = cid;
        return seeded.messages;
      });
      setHasMore(seeded.hasMore);
      void catchUp(maxSeq);
      return;
    }

    setLoading(true);
    loadingRef.current = true;
    msgsOwnerRef.current = null;
    setMessages([]);
    setHasMore(false);
    listMessages(cid, { limit: 50 })
      .then((res) => {
        if (activeChannelRef.current !== cid) return;
        const msgs = sortMessages(res.messages ?? res.data ?? []);
        let maxSeq = 0;
        for (const m of msgs) {
          if (typeof m.channel_seq === "number" && m.channel_seq > maxSeq)
            maxSeq = m.channel_seq;
        }
        lastSeqRef.current = maxSeq;
        setMessages(() => {
          msgsOwnerRef.current = cid;
          return msgs;
        });
        setHasMore(res.meta?.has_more_before ?? false);
        // A subscribe ack raced the initial load → run the deferred catch-up now
        // that the real seq cursor is known (a since_seq=0 catch-up would have
        // re-fetched the very page this load just delivered).
        if (pendingCatchUpRef.current) {
          pendingCatchUpRef.current = false;
          void catchUp(maxSeq);
        }
      })
      .catch(() => {
        if (activeChannelRef.current === cid) setLoadError(true);
      })
      .finally(() => {
        if (activeChannelRef.current === cid) {
          setLoading(false);
          loadingRef.current = false;
        }
      });
  }, [activeChannelRef, channel, isPreview, catchUp]);

  useEffect(() => {
    if (!channel || isPreview) {
      msgsOwnerRef.current = null;
      setMessages([]);
      setLoadError(false);
      return;
    }
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.channel_id, isPreview]);

  // Write-through: keep the per-channel cache current so the next entry into
  // this channel renders instantly. The owner guard makes the mid-switch commit
  // (new channel, previous channel's rows) a no-op.
  useEffect(() => {
    const cid = channel?.channel_id;
    if (!cid || msgsOwnerRef.current !== cid) return;
    setChannelCache(cid, { messages, hasMore });
  }, [messages, hasMore, channel?.channel_id]);

  // Opening a channel marks it read: clear the unread + mention badges
  // optimistically, then stamp last_read_at server-side so list_channels stops
  // counting either (both are gated on last_read_at).
  useEffect(() => {
    if (!channel || isPreview) return;
    if ((channel.unread_count ?? 0) > 0 || (channel.mention_count ?? 0) > 0)
      patchChannel(channel.channel_id, { unread_count: 0, mention_count: 0 });
    markChannelRead(channel.channel_id).catch(() => {});
  }, [channel?.channel_id, isPreview]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (activeChannelRef.current !== channel.channel_id) return;
      setMessages((prev) =>
        mergeMessages(prev, res.messages ?? res.data ?? []),
      );
      setHasMore(res.meta?.has_more_before ?? false);
    } catch {
      // hasMore stays true, so scrolling up again retries this page. Stable id so a
      // momentum-scroll at the top that re-fires loadMore collapses to one toast.
      toast.error("Couldn't load older messages — scroll up to try again", {
        id: "load-older-failed",
      });
    } finally {
      setLoadingMore(false);
    }
  }, [activeChannelRef, channel, messages, hasMore, loadingMore]);

  const handleMessage = useCallback((msg: Message) => {
    setMessages((prev) => upsertMessage(prev, msg));
    // A resolved approval landing → nudge the Audit board to re-fetch live.
    if (
      msg.msg_type === "permission" &&
      (msg.content_data as PermissionContentData | null | undefined)
        ?.resolved === true
    ) {
      onPermissionResolved();
    }
  }, [onPermissionResolved]);

  // Stream deltas arrive one WS frame per token chunk (tens/sec). Applying a
  // setMessages per frame runs a full channel render + O(N) list rebuild each time.
  // Instead buffer per-msg_id text and flush once per animation frame: the final
  // rendered content is byte-identical, only intermediate paint frequency drops from
  // token-rate to display-refresh-rate.
  const pendingDeltas = useRef<Map<string, string>>(new Map());
  const flushHandle = useRef<number | null>(null);

  useEffect(() => {
    pendingDeltas.current.clear();
    if (flushHandle.current !== null) {
      cancelAnimationFrame(flushHandle.current);
      flushHandle.current = null;
    }
    return () => {
      if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current);
    };
  }, [channel?.channel_id]);

  const flushDeltas = useCallback(() => {
    flushHandle.current = null;
    const batch = pendingDeltas.current;
    if (batch.size === 0) return;
    pendingDeltas.current = new Map();
    setMessages((prev) => {
      let out = prev;
      let copied = false; // true once `out` is a fresh array safe to mutate in place
      for (const [msgId, delta] of batch) {
        const idx = out.findIndex((m) => m.msg_id === msgId);
        if (idx === -1) {
          // Defensive: a delta beat its placeholder bubble — synthesize one.
          out = upsertMessage(out, {
            msg_id: msgId,
            sender_type: "bot",
            content: delta,
            is_partial: true,
            _streaming: true,
          });
          copied = true; // upsertMessage returns a fresh array
        } else {
          if (!copied) {
            out = out.slice();
            copied = true;
          }
          out[idx] = {
            ...out[idx],
            content: (out[idx].content ?? "") + delta,
            _streaming: true,
          };
        }
      }
      return out;
    });
  }, []);

  const handleStreamDelta = useCallback(
    (msgId: string, delta: string) => {
      const pending = pendingDeltas.current;
      pending.set(msgId, (pending.get(msgId) ?? "") + delta);
      if (flushHandle.current === null) {
        flushHandle.current = requestAnimationFrame(flushDeltas);
      }
    },
    [flushDeltas],
  );

  const handleStreamDone = useCallback(
    (update: Partial<Message> & { msg_id: string }) => {
      // The done frame carries the full final content and overwrites wholesale, so
      // any buffered deltas for this message are stale — drop them (flushing first
      // would either duplicate text or append after finalize).
      pendingDeltas.current.delete(update.msg_id);
      setMessages((prev) =>
        upsertMessage(prev, { ...update, _streaming: false, _trace: null }),
      );
    },
    [],
  );

  const handleBotTrace = useCallback(
    (event: TraceEvent) => {
      setMessages((prev) => {
        const current = prev.find((message) => message.msg_id === event.msg_id);
        const traceEvents = coalesceTraceEvents(
          current?._trace_events ?? [],
          [event],
        );
        return upsertMessage(prev, {
          msg_id: event.msg_id,
          _trace: event.title ?? event.status ?? null,
          _trace_events: traceEvents,
        });
      });
    },
    [],
  );

  const handleDeleted = useCallback((msgId: string) => {
    pendingDeltas.current.delete(msgId);
    setMessages((prev) =>
      prev.map((m) =>
        m.msg_id === msgId ? { ...m, is_deleted: true, content: "" } : m,
      ),
    );
  }, []);

  // Transcription finished (or terminally failed) → patch every rendered message
  // carrying that file so the audio tile updates in place, no reload needed.
  const handleFileTranscribed = useCallback(
    (fileId: string, status: string, summary: string | null) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (!m.files?.some((f) => f.file_id === fileId)) return m;
          return {
            ...m,
            files: m.files.map((f) =>
              f.file_id === fileId
                ? {
                    ...f,
                    summary: summary ?? f.summary,
                    transcript_status: status,
                  }
                : f,
            ),
          };
        }),
      );
    },
    [],
  );


  return {
    messages,
    setMessages,
    loading,
    loadError,
    hasMore,
    setHasMore,
    loadingMore,
    loadingRef,
    pendingCatchUpRef,
    pendingDeltas,
    catchUp,
    loadHistory,
    loadMore,
    handleMessage,
    handleStreamDelta,
    handleStreamDone,
    handleBotTrace,
    handleDeleted,
    handleFileTranscribed,
  };
}
