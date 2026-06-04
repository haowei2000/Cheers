import { useEffect, useRef, useCallback } from "react";
import { buildWsUrl } from "@/api/client";
import type { Message, WsEvent } from "@/types";

interface Callbacks {
  onMessage: (msg: Message) => void;
  onStreamDelta: (msgId: string, delta: string) => void;
  onStreamDone: (msg: Partial<Message> & { msg_id: string }) => void;
  onMessageDeleted: (msgId: string) => void;
  onBotProcessing?: (botId: string) => void;
}

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const MAX_RETRIES = 10;

export function useChatRealtime(channelId: string | null, cbs: Callbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const cbsRef = useRef(cbs);
  cbsRef.current = cbs;

  const connect = useCallback(() => {
    if (!channelId || !mountedRef.current) return;

    const ws = new WebSocket(buildWsUrl(`/ws/channels/${channelId}`));
    wsRef.current = ws;

    ws.onopen = () => {
      retryRef.current = 0;
    };

    ws.onmessage = (ev) => {
      let event: WsEvent;
      try {
        event = JSON.parse(ev.data as string) as WsEvent;
      } catch {
        return;
      }

      const { type, data } = event;

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
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      if (retryRef.current >= MAX_RETRIES) return;
      const delay = Math.min(
        BASE_DELAY * 2 ** retryRef.current,
        MAX_DELAY
      );
      retryRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [channelId]);

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
