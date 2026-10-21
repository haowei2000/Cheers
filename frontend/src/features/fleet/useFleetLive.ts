import { useEffect, useRef } from "react";
import { useAuthStore } from "@/stores/authStore";
import { clientSessionGeneration } from "@/lib/clientSession";
import { realtimeTransport } from "@/lib/realtimeTransport";

const DEBOUNCE_MS = 400;

/** Fleet uses channel events as REST invalidations, sharing the authenticated
 * transport and subscription leases with the open chat. */
export function useFleetLive(channelIds: string[], onEvent: () => void) {
  const session = useAuthStore((s) => s.token ? clientSessionGeneration() : null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const channelsKey = [...new Set(channelIds)].sort().join(",");

  useEffect(() => {
    if (session === null || !channelsKey) return;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => onEventRef.current(), DEBOUNCE_MS);
    };
    const unsubscribe = realtimeTransport().subscribeChannels(channelsKey.split(","), {
      onReady: fire,
      onFrame: ({ type }) => {
        if (["bot_processing", "message_done", "message", "presence"].includes(type)) fire();
      },
    });
    return () => {
      clearTimeout(debounce);
      unsubscribe();
    };
  }, [session, channelsKey]);
}
