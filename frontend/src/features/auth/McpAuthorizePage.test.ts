import { describe, expect, it } from "vitest";
import { selectConsentTarget } from "./McpAuthorizePage";

const hosts = [
  { host_id: "empty", device_name: "Offline", bot_id: "a", bot_name: "A", channels: [] },
  { host_id: "first", device_name: "Mac", bot_id: "b", bot_name: "B", channels: [{ channel_id: "general", name: "General" }] },
  { host_id: "target", device_name: "Phone", bot_id: "c", bot_name: "C", channels: [{ channel_id: "auth", name: "Auth" }] },
];

describe("MCP consent target", () => {
  it("preserves a requested channel even when another host sorts first", () => {
    expect(selectConsentTarget(hosts, "auth")).toEqual({ hostId: "target", channelId: "auth" });
  });

  it("requires a new choice when no host can access the requested channel", () => {
    expect(selectConsentTarget(hosts, "private")).toEqual({ hostId: "", channelId: "" });
  });

  it("chooses an eligible host for an unrestricted request and handles no hosts", () => {
    expect(selectConsentTarget(hosts)).toEqual({ hostId: "first", channelId: "general" });
    expect(selectConsentTarget([])).toEqual({ hostId: "", channelId: "" });
  });
});
