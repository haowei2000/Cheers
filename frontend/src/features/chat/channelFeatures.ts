import type { Channel } from "@/types";

export const CHANNEL_FEATURE_VOICE = "voice";

export function hasChannelFeature(channel: Channel, feature: string): boolean {
  if (channel.features) return channel.features.includes(feature);

  // Rolling-upgrade compatibility for gateways that still expose voice as kind.
  return feature === CHANNEL_FEATURE_VOICE && channel.kind === "voice";
}
