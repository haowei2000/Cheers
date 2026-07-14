import { useEffect, useRef } from "react";
import { buildWsUrl } from "@/api/client";
import { useAuthStore } from "@/stores/authStore";

// Live wire for the Fleet page (docs/design/FLEET_VIEW.md, P2): one WebSocket,
// subscribed to every channel in the current fleet payload. We don't render
// frame contents — any relevant frame just schedules a debounced refetch of
// the fleet endpoint (the single source of truth stays REST).
//
// Frames that change what Fleet shows:
//   bot_processing  → a bot started a turn (chip → working)
//   message_done    → a turn ended (chip → idle, approvals may have resolved)
//   message         → a new permission card may have landed
//   presence        → a connector came or went (dot flips)

const DEBOUNCE_MS = 400;
const RECONNECT_MS = 5_000;

export function useFleetLive(channelIds: string[], onEvent: () => void) {
  const token = useAuthStore((s) => s.token);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  // Key on membership, not array identity, so polling refreshes that return
  // the same channels don't tear the socket down.
  const channelsKey = [...channelIds].sort().join(",");

  useEffect(() => {
    if (!token || !channelsKey) return;
    let alive = true;
    let ws: WebSocket | null = null;
    let debounce: number | undefined;
    let reconnect: number | undefined;

    const fire = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => onEventRef.current(), DEBOUNCE_MS);
    };

    const connect = () => {
      if (!alive) return;
      ws = new WebSocket(buildWsUrl("/ws"));
      ws.onopen = () => ws?.send(JSON.stringify({ type: "auth", token }));
      ws.onmessage = (ev) => {
        let frame: { type?: string } = {};
        try {
          frame = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (frame.type === "auth_ok") {
          for (const id of channelsKey.split(",")) {
            ws?.send(JSON.stringify({ type: "subscribe", channel_id: id }));
          }
          return;
        }
        if (
          frame.type === "bot_processing" ||
          frame.type === "message_done" ||
          frame.type === "message" ||
          frame.type === "presence"
        ) {
          fire();
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        reconnect = window.setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      alive = false;
      window.clearTimeout(debounce);
      window.clearTimeout(reconnect);
      ws?.close();
    };
  }, [token, channelsKey]);
}
