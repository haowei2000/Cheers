import { useCallback, useEffect, useRef } from "react";
import { buildWsUrl } from "@/api/client";
import { useAuthStore } from "@/stores/authStore";

interface UserFrame {
  type?: string;
  scope?: string;
  data?: unknown;
}

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const MAX_RETRIES = 10;

/**
 * App-wide, user-scoped WebSocket. Unlike `useChatRealtime` (bound to the open
 * channel), this one stays connected for the whole session and ONLY authenticates —
 * it never subscribes to a channel. Its sole job is to receive `scope:"user"`
 * frames (invite notifications) even when no channel is open. The gateway's
 * `broadcast_user` fans out to every connection of the user, so this extra socket
 * gets the notification even while another socket is bound to a channel.
 *
 * Mounted once by ChatLayout (always mounted, unlike the rail on mobile).
 */
export function useUserSocket(onNotification: (data: unknown) => void) {
  const token = useAuthStore((s) => s.token);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const cbRef = useRef(onNotification);
  cbRef.current = onNotification;

  const connect = useCallback(() => {
    if (!token || !mountedRef.current) return;

    const ws = new WebSocket(buildWsUrl("/ws"));
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    };

    ws.onmessage = (ev) => {
      let frame: UserFrame;
      try {
        frame = JSON.parse(ev.data as string) as UserFrame;
      } catch {
        return;
      }
      if (frame.type === "auth_ok") {
        retryRef.current = 0;
        return;
      }
      if (frame.type === "auth_err") {
        ws.close();
        return;
      }
      // The only user-scoped frame we care about (invites; extensible later).
      if (frame.type === "notification") {
        cbRef.current(frame.data);
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current || retryRef.current >= MAX_RETRIES) return;
      const delay = Math.min(BASE_DELAY * 2 ** retryRef.current, MAX_DELAY);
      retryRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
  }, [token]);

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
