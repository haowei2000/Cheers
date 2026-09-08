import { describe, expect, it } from "vitest";
import { mentionCandidatesFromMembers } from "./useChannelRoster";

describe("mentionCandidatesFromMembers", () => {
  it("derives current avatar and presence data from the live roster", () => {
    expect(mentionCandidatesFromMembers([
      {
        member_id: "bot-123456789",
        member_type: "bot",
        username: "helper",
        display_name: "Helper",
        avatar_url: "/api/v1/avatars/helper.png",
        is_online: true,
        can_receive_audio: true,
      },
    ])).toEqual([
      {
        id: "bot-123456789",
        type: "bot",
        label: "Helper",
        sublabel: "helper",
        avatarUrl: "/api/v1/avatars/helper.png",
        isOnline: true,
        canReceiveAudio: true,
      },
    ]);
  });

  it("recomputes a candidate when a roster patch changes its avatar", () => {
    const member = {
      member_id: "user-123456789",
      member_type: "user",
      username: "alice",
      avatar_url: "/avatars/old.png",
    };
    expect(mentionCandidatesFromMembers([
      { ...member, avatar_url: "/avatars/new.png" },
    ])[0].avatarUrl).toBe("/avatars/new.png");
  });
});
