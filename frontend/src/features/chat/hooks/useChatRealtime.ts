import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { buildWsUrl } from "../../../api";
import type { AuthFetch } from "../../../api/client";
import { AGENT_BRIDGE_TASK_KIND } from "../../../lib/agent-bridge";
import { API } from "../../../lib/app-config";
import {
  botTraceStatusText,
  makeClientStreamTrace,
  trimBotTraceEvents,
} from "../../../lib/bot-trace";
import { MAX_LOADED_MESSAGES, type PendingStreamDelta } from "../../../lib/message-window";
import {
  patchMessage,
  patchMessages,
  upsertMessage,
  type MessageStore,
} from "../../../lib/message-store";
import type {
  AgentBridgeTaskContentData,
  BotTraceEvent,
  ContextData,
  Message,
} from "../../../types";

interface UseChatRealtimeOptions {
  selectedId: string | null;
  authFetch: AuthFetch;
  setContextData: Dispatch<SetStateAction<ContextData>>;
  setMessageStore: Dispatch<SetStateAction<MessageStore>>;
  setProcessingBots: Dispatch<SetStateAction<Record<string, string>>>;
  reportClientError: (
    method: string,
    url: string,
    status: number,
    detail: string,
  ) => void;
}

export function useChatRealtime({
  selectedId,
  authFetch,
  setContextData,
  setMessageStore,
  setProcessingBots,
  reportClientError,
}: UseChatRealtimeOptions) {
  const streamDeltaBufferRef = useRef<Record<string, PendingStreamDelta>>({});
  const streamDeltaRafRef = useRef<number | null>(null);

  const flushStreamDeltaBuffer = useCallback(() => {
    const pending = streamDeltaBufferRef.current;
    streamDeltaBufferRef.current = {};
    if (streamDeltaRafRef.current !== null) {
      cancelAnimationFrame(streamDeltaRafRef.current);
      streamDeltaRafRef.current = null;
    }

    const entries = Object.entries(pending).filter(
      ([, item]) => item.delta.length > 0,
    );
    if (entries.length === 0) return;

    setMessageStore((prev) =>
      patchMessages(
        prev,
        entries.map(([msgId, item]) => ({
          msgId,
          update: (m) => {
            const taskData =
              m.content_data?.kind === AGENT_BRIDGE_TASK_KIND
                ? (m.content_data as AgentBridgeTaskContentData)
                : m._agent_bridge_task;
            const switchingFromTaskCard =
              m.content_data?.kind === AGENT_BRIDGE_TASK_KIND;
            const nextContent = switchingFromTaskCard
              ? item.delta
              : `${m.content || ""}${item.delta}`;
            return {
              ...m,
              content: nextContent,
              content_data: switchingFromTaskCard ? null : m.content_data,
              _agent_bridge_task: taskData
                ? {
                    ...taskData,
                    status: "streaming",
                    message: "Receiving provider output.",
                  }
                : m._agent_bridge_task,
              _bot_trace: trimBotTraceEvents([
                ...(m._bot_trace || []),
                makeClientStreamTrace(
                  m,
                  "message_stream",
                  "Received streaming chunk",
                  {
                    event_type: "message_stream",
                    delta_chars: item.delta.length,
                    delta_preview: item.delta.slice(0, 160),
                    accumulated_chars: nextContent.length,
                    coalesced_chunks: item.chunks,
                  },
                  item.chunks > 1
                    ? `+${item.delta.length} chars / ${item.chunks} chunks`
                    : `+${item.delta.length} chars`,
                ),
              ]),
              _streaming: true,
            };
          },
        })),
      ),
    );
  }, []);

  const queueStreamDelta = useCallback(
    (msgId: unknown, value: unknown) => {
      const id = typeof msgId === "string" ? msgId : "";
      const delta =
        typeof value === "string" ? value : value == null ? "" : String(value);
      if (!id || !delta) return;

      const current = streamDeltaBufferRef.current[id];
      streamDeltaBufferRef.current[id] = {
        delta: `${current?.delta || ""}${delta}`,
        chunks: (current?.chunks || 0) + 1,
      };
      if (streamDeltaRafRef.current === null) {
        streamDeltaRafRef.current = requestAnimationFrame(() => {
          streamDeltaRafRef.current = null;
          flushStreamDeltaBuffer();
        });
      }
    },
    [flushStreamDeltaBuffer],
  );

  useEffect(() => {
    if (!selectedId) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let disposed = false;
    const MAX_RETRIES = 10;
    const BASE_DELAY = 1000;
    const MAX_DELAY = 30000;

    function connect() {
      if (disposed) return;
      ws = new WebSocket(buildWsUrl(`/ws/channels/${selectedId}`));

      ws.onopen = () => {
        retryCount = 0;
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "bot_processing" && msg.data) {
            const { bot_id, username } = msg.data;
            if (bot_id) {
              setProcessingBots((prev) => ({
                ...prev,
                [bot_id]: username || bot_id,
              }));
            }
          } else if (msg.type === "message" && msg.data) {
            // Bot placeholder arrived → clear the per-bot thinking indicator.
            if (msg.data.sender_type === "bot" && msg.data.sender_id) {
              setProcessingBots((prev) => {
                if (!(msg.data.sender_id in prev)) return prev;
                const next = { ...prev };
                delete next[msg.data.sender_id];
                return next;
              });
            }
            setMessageStore((prev) => {
              const incoming = msg.data as Message;
              const id = incoming.msg_id;
              if (id && prev.byId[id]) {
                // Already present — merge post-hoc updates (e.g. permission
                // card resolution flipping content_data.resolved). Keep any
                // client-local transient fields like _streaming.
                return patchMessage(prev, id, (m) => ({
                  ...m,
                  content: incoming.content ?? m.content,
                  content_data: incoming.content_data ?? m.content_data,
                  msg_type: incoming.msg_type ?? m.msg_type,
                }));
              }
              const entry =
                incoming.sender_type === "bot"
                  ? {
                      ...incoming,
                      _streaming: true,
                      _bot_trace: [
                        makeClientStreamTrace(
                          incoming,
                          "placeholder",
                          "Create bot reply placeholder",
                          { event_type: "message" },
                        ),
                      ],
                    }
                  : incoming;
              return upsertMessage(prev, entry, MAX_LOADED_MESSAGES);
            });
            if (
              msg.data.sender_type === "bot" &&
              typeof msg.data.content === "string" &&
              msg.data.content.includes("Updated memory layer")
            ) {
              authFetch(`${API}/channels/${selectedId}/context`)
                .then((r) => r.json())
                .then((d) => d.data && setContextData(d.data))
                .catch(() => {});
            }
          } else if (msg.type === "message_stream" && msg.data) {
            const { msg_id, delta } = msg.data;
            queueStreamDelta(msg_id, delta);
          } else if (msg.type === "bot_trace" && msg.data) {
            const trace = msg.data as BotTraceEvent;
            if (!trace.msg_id) return;
            const status = botTraceStatusText(trace);
            setMessageStore((prev) =>
              patchMessage(prev, trace.msg_id!, (m) => ({
                ...m,
                _bot_status: status,
                _bot_trace: trimBotTraceEvents([
                  ...(m._bot_trace || []),
                  { ...trace, ts: trace.ts ?? Date.now() },
                ]),
              })),
            );
          } else if (msg.type === "message_done" && msg.data) {
            const { msg_id, content, files, file_ids, is_partial, error } = msg.data;
            flushStreamDeltaBuffer();
            const hasContentData = Object.prototype.hasOwnProperty.call(
              msg.data,
              "content_data",
            );
            const nextContentData = hasContentData
              ? msg.data.content_data
              : undefined;
            setMessageStore((prev) =>
              patchMessage(prev, msg_id, (m) => {
                const priorTask =
                  m.content_data?.kind === AGENT_BRIDGE_TASK_KIND
                    ? (m.content_data as AgentBridgeTaskContentData)
                    : m._agent_bridge_task;
                const nextTask =
                  nextContentData?.kind === AGENT_BRIDGE_TASK_KIND
                    ? (nextContentData as AgentBridgeTaskContentData)
                    : priorTask
                      ? {
                          ...priorTask,
                          status: error
                            ? "error"
                            : is_partial
                              ? "partial"
                              : "done",
                          message: error
                            ? String(error)
                            : is_partial
                              ? "Task was interrupted. Current output was preserved."
                              : "Task completed.",
                        }
                      : m._agent_bridge_task;
                return {
                  ...m,
                  content,
                  content_data:
                    nextContentData !== undefined
                      ? nextContentData
                      : m.content_data?.kind === AGENT_BRIDGE_TASK_KIND
                        ? null
                        : m.content_data,
                  _agent_bridge_task: nextTask,
                  _streaming: false,
                  _bot_trace: trimBotTraceEvents([
                    ...(m._bot_trace || []),
                    makeClientStreamTrace(
                      m,
                      error
                        ? "message_done_error"
                        : is_partial
                          ? "message_done_partial"
                          : "message_done",
                      error
                        ? "Streaming reply failed"
                        : is_partial
                          ? "Streaming reply interrupted"
                          : "Streaming reply completed",
                      {
                        event_type: "message_done",
                        content_chars: String(content || "").length,
                        is_partial: Boolean(is_partial),
                        error: error || null,
                        file_count: Array.isArray(files)
                          ? files.length
                          : Array.isArray(file_ids)
                            ? file_ids.length
                            : 0,
                      },
                      error
                        ? String(error)
                        : `${String(content || "").length} chars`,
                    ),
                  ]),
                  _bot_status: undefined,
                  ...(files ? { files } : {}),
                  ...(file_ids ? { file_ids } : {}),
                  ...(typeof is_partial === "boolean"
                    ? { is_partial }
                    : {}),
                };
              }),
            );
            if (
              typeof content === "string" &&
              content.includes("Updated memory layer")
            ) {
              authFetch(`${API}/channels/${selectedId}/context`)
                .then((r) => r.json())
                .then((d) => d.data && setContextData(d.data))
                .catch(() => {});
            }
          }
        } catch {}
      };

      ws.onerror = () => {
        reportClientError(
          "WS",
          `/ws/channels/${selectedId}`,
          0,
          "websocket error",
        );
      };

      ws.onclose = () => {
        if (disposed) return;
        if (retryCount < MAX_RETRIES) {
          const delay = Math.min(
            BASE_DELAY * Math.pow(2, retryCount),
            MAX_DELAY,
          );
          retryCount++;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (streamDeltaRafRef.current !== null) {
        cancelAnimationFrame(streamDeltaRafRef.current);
        streamDeltaRafRef.current = null;
      }
      streamDeltaBufferRef.current = {};
      if (ws) ws.close();
    };
  }, [selectedId, reportClientError, flushStreamDeltaBuffer, queueStreamDelta]);

}
