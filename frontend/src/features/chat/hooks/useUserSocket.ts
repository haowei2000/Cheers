import { useEffect, useRef } from "react";
import { useAuthStore } from "@/stores/authStore";
import { realtimeTransport } from "@/lib/realtimeTransport";

/** Retains user events even when no channel is open. Shares authentication and
 * recovery with chat and Fleet; a new connection reconciles durable activity. */
export function useUserSocket(onFrame: (type: string, data: unknown) => void) {
  const token = useAuthStore((s) => s.token);
  const cbRef = useRef(onFrame);
  cbRef.current = onFrame;
  useEffect(() => {
    if (!token) return;
    return realtimeTransport().subscribeUser({
      onReady: () => cbRef.current("connected", undefined),
      onFrame: ({ type, data }) => {
        if (["notification", "notification_resolved", "dm_created", "voice_presence"].includes(type)) {
          cbRef.current(type, data);
        }
      },
    });
  }, [token]);
}
