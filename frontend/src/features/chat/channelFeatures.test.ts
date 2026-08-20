import { describe, expect, it } from "vitest";
import type { Channel } from "@/types";
import { CHANNEL_FEATURE_VOICE, hasChannelFeature } from "./channelFeatures";

const channel = (fields: Partial<Channel>): Channel => ({
  channel_id: "channel-1",
  name: "general",
  type: "public",
  ...fields,
});

describe("hasChannelFeature", () => {
  it("uses the feature list as the authority when present", () => {
    expect(hasChannelFeature(channel({ features: ["voice"] }), CHANNEL_FEATURE_VOICE)).toBe(true);
    expect(hasChannelFeature(channel({ features: [], kind: "voice" }), CHANNEL_FEATURE_VOICE)).toBe(false);
  });

  it("falls back to the legacy kind when features are absent", () => {
    expect(hasChannelFeature(channel({ kind: "voice" }), CHANNEL_FEATURE_VOICE)).toBe(true);
  });
});
