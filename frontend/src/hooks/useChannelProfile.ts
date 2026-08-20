import { useEffect, useState } from "react";
import { getChannelProfile, type ChannelProfile } from "@/api/channelProfiles";

export function useChannelProfile(
  channelId: string,
  enabled = true,
  refreshKey?: unknown,
): ChannelProfile | null {
  const [profile, setProfile] = useState<ChannelProfile | null>(null);

  useEffect(() => setProfile(null), [channelId]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () => {
      void getChannelProfile(channelId)
        .then((value) => { if (active) setProfile(value); })
        .catch(() => { if (active) setProfile(null); });
    };
    load();
    const interval = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [channelId, enabled, refreshKey]);

  return profile;
}
