import { useEffect, useRef } from "react";
import { useAuthStore } from "@/stores/authStore";
import { clientSessionGeneration } from "@/lib/clientSession";
import { realtimeTransport } from "@/lib/realtimeTransport";

/** Retains user events even when no channel is open. Shares authentication and
 * recovery with chat and Fleet; a new connection reconciles durable activity. */
export function useUserSocket(onFrame: (type: string, data: unknown) => void) {
  const session = useAuthStore((s) => s.token ? clientSessionGeneration() : null);
  const cbRef = useRef(onFrame);
  cbRef.current = onFrame;
  useEffect(() => {
    if (session === null) return;
    return realtimeTransport().subscribeUser({
      onReady: () => cbRef.current("connected", undefined),
      onFrame: ({ type, data }) => {
        if (["notification", "notification_resolved", "dm_created", "voice_presence"].includes(type)) {
          cbRef.current(type, data);
        }
      },
    });
  }, [session]);
}
