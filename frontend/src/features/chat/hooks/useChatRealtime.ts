import { useEffect, useRef, useCallback } from "react";
import { buildWsUrl } from "@/api/client";
import { useAuthStore } from "@/stores/authStore";
import type { Message, WsEvent } from "@/types";

interface Callbacks {
  onMessage: (msg: Message) => void;
  onStreamDelta: (msgId: string, delta: string) => void;
  onStreamDone: (msg: Partial<Message> & { msg_id: string }) => void;
  onMessageDeleted: (msgId: string) => void;
  onBotProcessing?: (botId: string) => void;
  /** Fired after every (re)subscribe ack — used to run REST seq catch-up. */
  onReady?: () => void;
  /** Channel presence update (online user ids + count). */
  onPresence?: (userIds: string[], count: number) => void;
}

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const MAX_RETRIES = 10;

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
        const d = data as { online_user_ids?: string[]; count?: number };
        cbsRef.current.onPresence?.(d.online_user_ids ?? [], d.count ?? 0);
      }
    };

    ws.onclose = () => {
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
}
