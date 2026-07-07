import { useEffect, useRef, useCallback } from "react";
import { buildWsUrl } from "@/api/client";
import { useAuthStore } from "@/stores/authStore";
import type { Message, WsEvent } from "@/types";

/** Workspace-presence entry inside a `presence` frame: WHO is currently viewing
 *  WHICH bot's workspace, and at what `path` (a file, else a directory/cwd). */
export interface PresenceFocus {
  user_id: string;
  bot_id: string;
  path?: string | null;
}

interface Callbacks {
  onMessage: (msg: Message) => void;
  onStreamDelta: (msgId: string, delta: string) => void;
  onStreamDone: (msg: Partial<Message> & { msg_id: string }) => void;
  onMessageDeleted: (msgId: string) => void;
  onBotProcessing?: (botId: string) => void;
  /** Fired after every (re)subscribe ack — used to run REST seq catch-up. */
  onReady?: () => void;
  /** Channel presence update (online user ids + count + online bot ids).
   *  `count` already includes online bots — don't add `botIds.length` to it.
   *  `focus` (workspace presence) may be absent on older gateways → empty array. */
  onPresence?: (
    userIds: string[],
    count: number,
    botIds?: string[],
    focus?: PresenceFocus[]
  ) => void;
  /** Agent progress (trace) for a streaming bot message. */
  onBotTrace?: (msgId: string | null, title: string | null) => void;
  /** ViewBoard live-push: a board's underlying data changed → re-pull that board.
   *  `board` is e.g. "plan" | "cost" | "commands" (gateway board_signal) or
   *  "activity" (synthesized here on each new message). */
  onBoardSignal?: (board: string) => void;
  /** Live-watch: the agent changed file(s) under a watched dir on ITS machine.
   *  Carries `bot_id` (route by it — a channel can have several bots on different
   *  machines), the workspace `root`, and the changed `paths`. Recipients re-fetch
   *  through their own authorized workspace REST reads (the frame has no content). */
  onWorkspaceSignal?: (sig: {
    bot_id: string;
    root: string;
    paths: string[];
  }) => void;
  /** An audio file's transcription finished (status "done" with the transcript
   *  snippet) or terminally failed (status "failed") — update its tiles in place. */
  onFileTranscribed?: (
    fileId: string,
    status: string,
    summary: string | null
  ) => void;
  /** A member edited their profile (name/avatar/bio/status) — patch that member's
   *  card in place so the hovercard reflects it without a channel-switch/reload.
   *  Only the provided fields are meaningful; `member_id` always identifies who. */
  onMemberUpdated?: (member: {
    member_id: string;
    display_name?: string | null;
    avatar_url?: string | null;
    bio?: string | null;
    status_text?: string | null;
    status_emoji?: string | null;
  }) => void;
}

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const MAX_RETRIES = 10;

// ── Resource req/res over the same channel socket (workbench fs/channel access) ──

const RESOURCE_REQ_TIMEOUT = 15000;

/** Result payload of a resource_req on success (handler `data`). */
export type ResourceData = unknown;

/** Thrown when a resource_req fails (rejected by dispatch_user or transport). */
export class ResourceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResourceError";
    this.code = code;
  }
}

interface ResourceRes {
  ok: boolean;
  data?: unknown;
  code?: string;
  error?: string;
}

interface PendingReq {
  resolve: (data: ResourceData) => void;
  reject: (err: ResourceError) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Backend browser WS protocol:
//   1. Connect to /ws
//   2. Client → {"type":"auth","token":"..."}
//   3. Server → {"type":"auth_ok","user_id":"..."}
//   4. Client → {"type":"subscribe","channel_id":"..."}
//   5. Server → {"type":"subscribed","channel_id":"..."}
//   6. Broadcast frames arrive tagged with channel_id

export function useChatRealtime(channelId: string | null, cbs: Callbacks) {
  const token = useAuthStore((s) => s.token);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const cbsRef = useRef(cbs);
  cbsRef.current = cbs;
  const pendingRef = useRef<Map<string, PendingReq>>(new Map());

  const connect = useCallback(() => {
    if (!channelId || !token || !mountedRef.current) return;

    const ws = new WebSocket(buildWsUrl("/ws"));
    wsRef.current = ws;

    ws.onopen = () => {
      // Phase 1: authenticate
      ws.send(JSON.stringify({ type: "auth", token }));
    };

    ws.onmessage = (ev) => {
      let event: WsEvent;
      try {
        event = JSON.parse(ev.data as string) as WsEvent;
      } catch {
        return;
      }

      // Resource req/res correlation (workbench fs/channel access over this socket).
      if ((event as { type?: string }).type === "resource_res") {
        const res = event as unknown as ResourceRes & { req_id?: string };
        const pending = res.req_id
          ? pendingRef.current.get(res.req_id)
          : undefined;
        if (pending && res.req_id) {
          pendingRef.current.delete(res.req_id);
          clearTimeout(pending.timer);
          if (res.ok) pending.resolve(res.data);
          else
            pending.reject(
              new ResourceError(res.code ?? "ERROR", res.error ?? "resource error")
            );
        }
        return;
      }

      const { type, data } = event;

      // Protocol control frames — handle then return
      if (type === "auth_ok") {
        retryRef.current = 0;
        // Phase 2: subscribe to the target channel
        ws.send(JSON.stringify({ type: "subscribe", channel_id: channelId }));
        return;
      }
      if (type === "auth_err") {
        ws.close();
        return;
      }
      if (type === "subscribed") {
        // (Re)subscribe ack — trigger REST since-seq catch-up to heal any gap
        // from a dropped connection (write-before-deliver self-heal).
        cbsRef.current.onReady?.();
        return;
      }
      if (type === "unsubscribed" || type === "pong") {
        return;
      }

      // Broadcast frames
      if (type === "message") {
        cbsRef.current.onMessage(data as unknown as Message);
        // A new message advances the channel's activity stream → nudge the board.
        cbsRef.current.onBoardSignal?.("activity");
      } else if (type === "message_stream") {
        const d = data as { msg_id: string; delta: string };
        cbsRef.current.onStreamDelta(d.msg_id, d.delta ?? "");
      } else if (type === "message_done") {
        cbsRef.current.onStreamDone(
          data as unknown as Partial<Message> & { msg_id: string }
        );
      } else if (type === "message_deleted") {
        cbsRef.current.onMessageDeleted(
          (data as { msg_id: string }).msg_id
        );
      } else if (type === "bot_processing") {
        cbsRef.current.onBotProcessing?.(
          (data as { bot_id: string }).bot_id
        );
      } else if (type === "presence") {
        const d = data as {
          online_user_ids?: string[];
          online_bot_ids?: string[];
          count?: number;
          focus?: PresenceFocus[];
        };
        // `focus` is new (workspace presence); tolerate its absence on older gateways.
        const focus = Array.isArray(d.focus)
          ? d.focus.filter(
              (f): f is PresenceFocus =>
                !!f && typeof f.user_id === "string" && typeof f.bot_id === "string"
            )
          : [];
        cbsRef.current.onPresence?.(
          d.online_user_ids ?? [],
          d.count ?? 0,
          d.online_bot_ids ?? [],
          focus
        );
      } else if (type === "bot_trace") {
        const d = data as {
          msg_id?: string | null;
          title?: string | null;
          status?: string | null;
        };
        cbsRef.current.onBotTrace?.(d.msg_id ?? null, d.title ?? d.status ?? null);
      } else if (type === "board_signal") {
        cbsRef.current.onBoardSignal?.((data as { board?: string }).board ?? "");
      } else if (type === "workspace_signal") {
        const d = data as {
          bot_id?: string;
          root?: string;
          paths?: string[];
        };
        if (d.bot_id) {
          cbsRef.current.onWorkspaceSignal?.({
            bot_id: d.bot_id,
            root: d.root ?? "",
            paths: Array.isArray(d.paths) ? d.paths : [],
          });
        }
      } else if (type === "file_transcribed") {
        const d = data as {
          file_id?: string;
          status?: string;
          summary?: string | null;
        };
        if (d.file_id) {
          cbsRef.current.onFileTranscribed?.(
            d.file_id,
            d.status ?? "done",
            d.summary ?? null
          );
        }
      } else if (type === "member_updated") {
        const d = data as { member_id?: string };
        if (d.member_id) {
          cbsRef.current.onMemberUpdated?.(
            data as { member_id: string } & Record<string, unknown>
          );
        }
      }
    };

    ws.onclose = () => {
      // Reject any in-flight resource requests bound to this socket.
      for (const p of pendingRef.current.values()) {
        clearTimeout(p.timer);
        p.reject(new ResourceError("DISCONNECTED", "socket closed"));
      }
      pendingRef.current.clear();
      if (!mountedRef.current) return;
      if (retryRef.current >= MAX_RETRIES) return;
      const delay = Math.min(BASE_DELAY * 2 ** retryRef.current, MAX_DELAY);
      retryRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [channelId, token]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // Imperative resource client: send a resource_req on the live channel socket and
  // resolve when the matching resource_res (by req_id) returns. Used by the workbench
  // (File/Context plugins) to read/write the channel workspace fs.
  const sendResourceReq = useCallback(
    (resource: string, params: Record<string, unknown>): Promise<ResourceData> => {
      return new Promise<ResourceData>((resolve, reject) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new ResourceError("DISCONNECTED", "socket not connected"));
          return;
        }
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingRef.current.delete(reqId);
          reject(new ResourceError("TIMEOUT", "resource request timed out"));
        }, RESOURCE_REQ_TIMEOUT);
        pendingRef.current.set(reqId, { resolve, reject, timer });
        ws.send(
          JSON.stringify({ type: "resource_req", req_id: reqId, resource, params })
        );
      });
    },
    []
  );

  // Broadcast the caller's workspace focus (which bot's workspace / which path they're
  // viewing) so peers see it in the next `presence` snapshot. `focus === null` clears it
  // (dialog closed / bot switched). Best-effort: a no-op if the socket isn't open —
  // the gateway re-derives presence on the next (re)subscribe anyway.
  const sendPresenceFocus = useCallback(
    (chanId: string, focus: { bot_id: string; path?: string | null } | null) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({ type: "presence_focus", channel_id: chanId, focus })
      );
    },
    []
  );

  return { sendResourceReq, sendPresenceFocus };
}
