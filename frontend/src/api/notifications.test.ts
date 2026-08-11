import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  acceptChannel: vi.fn(),
  declineChannel: vi.fn(),
  acceptBot: vi.fn(),
  declineBot: vi.fn(),
  acceptWorkspace: vi.fn(),
  declineWorkspace: vi.fn(),
  acceptFriend: vi.fn(),
  cancelFriendRequest: vi.fn(),
}));

vi.mock("./channels", () => ({
  acceptChannelInvite: calls.acceptChannel,
  declineChannelInvite: calls.declineChannel,
  acceptBotChannelInvite: calls.acceptBot,
  declineBotChannelInvite: calls.declineBot,
}));
vi.mock("./workspaces", () => ({
  acceptInvite: calls.acceptWorkspace,
  declineInvite: calls.declineWorkspace,
}));
vi.mock("./friends", () => ({
  acceptFriendRequest: calls.acceptFriend,
  cancelFriendRequest: calls.cancelFriendRequest,
}));

import {
  acceptNotification,
  declineNotification,
  notificationKey,
  type NotificationItem,
} from "./notifications";

function item(
  kind: NotificationItem["kind"],
  extras: Partial<NotificationItem> = {}
): NotificationItem {
  return {
    id: `${kind}:stable-id`,
    kind,
    title: "Example",
    actor_id: "actor",
    actor_name: "Actor",
    created_at: "2026-08-08T00:00:00Z",
    ...extras,
  };
}

describe("Activity notification routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the server notification id as the cross-device identity", () => {
    const notification = item("channel_invite", { channel_id: "channel" });
    expect(notificationKey(notification)).toBe("channel_invite:stable-id");
  });

  it("routes accept actions for all supported kinds", async () => {
    await acceptNotification(item("friend_request", { requester_user_id: "friend" }));
    await acceptNotification(item("workspace_invite", { workspace_id: "workspace" }));
    await acceptNotification(item("channel_invite", { channel_id: "channel" }));
    await acceptNotification(
      item("bot_channel_invite", { channel_id: "channel", bot_id: "bot" })
    );

    expect(calls.acceptFriend).toHaveBeenCalledWith("friend");
    expect(calls.acceptWorkspace).toHaveBeenCalledWith("workspace");
    expect(calls.acceptChannel).toHaveBeenCalledWith("channel");
    expect(calls.acceptBot).toHaveBeenCalledWith("channel", "bot");
  });

  it("routes decline actions for all supported kinds", async () => {
    await declineNotification(item("friend_request", { friendship_id: "friendship" }));
    await declineNotification(item("workspace_invite", { workspace_id: "workspace" }));
    await declineNotification(item("channel_invite", { channel_id: "channel" }));
    await declineNotification(
      item("bot_channel_invite", { channel_id: "channel", bot_id: "bot" })
    );

    expect(calls.cancelFriendRequest).toHaveBeenCalledWith("friendship");
    expect(calls.declineWorkspace).toHaveBeenCalledWith("workspace");
    expect(calls.declineChannel).toHaveBeenCalledWith("channel");
    expect(calls.declineBot).toHaveBeenCalledWith("channel", "bot");
  });
});
