import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ChannelProfile } from "@/api/channelProfiles";
import { channelProfileStore } from "@/stores/channelProfileStore";

export function useChannelProfile(
  channelId: string,
  enabled = true,
  refreshKey?: unknown,
): ChannelProfile | null {
  const resource = channelProfileStore.resource(channelId);
  const key = useRef(refreshKey);
  key.current = refreshKey;
  const subscribe = useMemo(() => (notify: () => void) => resource.subscribe(notify, enabled, key.current), [resource, enabled]);
  const profile = useSyncExternalStore(subscribe, resource.snapshot, resource.snapshot);
  useEffect(() => {
    if (enabled) resource.invalidate(refreshKey);
  }, [resource, enabled, refreshKey]);
  return profile;
}
