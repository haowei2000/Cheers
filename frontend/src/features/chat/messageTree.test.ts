import { describe, expect, it } from "vitest";
import {
  groupMessagesByReply,
  isDiscussionConsecutive,
  isVisuallyConsecutive,
  messageSessionId,
} from "./messageTree";
import type { Message } from "@/types";

function msg(
  partial: Partial<Message> & Pick<Message, "msg_id" | "sender_id">,
): Message {
  return {
    sender_type: "user",
    content: "",
    ...partial,
  };
}

describe("groupMessagesByReply", () => {
  it("keeps messages without reply_to as roots", () => {
    const a = msg({ msg_id: "a", sender_id: "u1", channel_seq: 1 });
    const b = msg({ msg_id: "b", sender_id: "u2", channel_seq: 2 });
    const { roots, childrenByParent } = groupMessagesByReply([a, b]);
    expect(roots.map((m) => m.msg_id)).toEqual(["a", "b"]);
    expect(childrenByParent.size).toBe(0);
  });

  it("nests replies under their parent when parent is loaded", () => {
    const root = msg({ msg_id: "root", sender_id: "u1", channel_seq: 1 });
    const bot = msg({
      msg_id: "bot1",
      sender_id: "b1",
      sender_type: "bot",
      reply_to_msg_id: "root",
      channel_seq: 2,
    });
    const reply = msg({
      msg_id: "r1",
      sender_id: "u1",
      reply_to_msg_id: "bot1",
      channel_seq: 3,
    });
    const { roots, childrenByParent } = groupMessagesByReply([root, bot, reply]);
    expect(roots.map((m) => m.msg_id)).toEqual(["root"]);
    expect(childrenByParent.get("root")?.map((m) => m.msg_id)).toEqual(["bot1"]);
    expect(childrenByParent.get("bot1")?.map((m) => m.msg_id)).toEqual(["r1"]);
  });

  it("treats orphan replies as roots when parent is missing", () => {
    const orphan = msg({
      msg_id: "o1",
      sender_id: "u1",
      reply_to_msg_id: "missing",
      channel_seq: 1,
    });
    const { roots } = groupMessagesByReply([orphan]);
    expect(roots.map((m) => m.msg_id)).toEqual(["o1"]);
  });

  it("folds anchored permissions out of the tree", () => {
    const bot = msg({
      msg_id: "bot1",
      sender_id: "b1",
      sender_type: "bot",
      channel_seq: 1,
    });
    const perm = msg({
      msg_id: "p1",
      sender_id: "b1",
      sender_type: "bot",
      msg_type: "permission",
      content_data: { source_msg_id: "bot1", request_id: "req1" },
      channel_seq: 2,
    });
    const { roots, byId } = groupMessagesByReply([bot, perm]);
    expect(roots.map((m) => m.msg_id)).toEqual(["bot1"]);
    expect(byId.has("p1")).toBe(false);
  });
});

describe("messageSessionId", () => {
  it("reads session_id from content_data", () => {
    const m = msg({
      msg_id: "b",
      sender_id: "bot",
      content_data: { session_id: "sid-1" },
    });
    expect(messageSessionId(m)).toBe("sid-1");
  });

  it("returns null when absent", () => {
    expect(messageSessionId(msg({ msg_id: "b", sender_id: "bot" }))).toBeNull();
  });
});

describe("isVisuallyConsecutive", () => {
  const at = (minute: number) => `2026-08-09T10:${String(minute).padStart(2, "0")}:00Z`;

  it("groups nearby root messages from the same sender", () => {
    const first = msg({ msg_id: "a", sender_id: "u1", created_at: at(0) });
    const next = msg({ msg_id: "b", sender_id: "u1", created_at: at(4) });
    expect(isVisuallyConsecutive(first, next)).toBe(true);
  });

  it("restores the author header after the visual grouping window", () => {
    const first = msg({ msg_id: "a", sender_id: "u1", created_at: at(0) });
    const next = msg({ msg_id: "b", sender_id: "u1", created_at: at(6) });
    expect(isVisuallyConsecutive(first, next)).toBe(false);
  });

  it("never folds a reply into a previous root message", () => {
    const first = msg({ msg_id: "a", sender_id: "u1", created_at: at(0) });
    const reply = msg({
      msg_id: "b",
      sender_id: "u1",
      created_at: at(1),
      reply_to_msg_id: "missing-parent",
    });
    expect(isVisuallyConsecutive(first, reply)).toBe(false);
  });

  it("keeps structured message types visually independent", () => {
    const first = msg({ msg_id: "a", sender_id: "bot", created_at: at(0) });
    const task = msg({
      msg_id: "b",
      sender_id: "bot",
      sender_type: "bot",
      msg_type: "task_claim_confirmation",
      created_at: at(1),
    });
    expect(isVisuallyConsecutive(first, task)).toBe(false);
  });
});

describe("isDiscussionConsecutive", () => {
  it("groups replies from the same sender and parent within thirty minutes", () => {
    const first = msg({ msg_id: "a", sender_id: "u1", reply_to_msg_id: "root", created_at: "2026-08-09T10:00:00Z" });
    const next = msg({ msg_id: "b", sender_id: "u1", reply_to_msg_id: "root", created_at: "2026-08-09T10:29:00Z" });
    expect(isDiscussionConsecutive(first, next)).toBe(true);
  });

  it("keeps identity visible when the reply target changes", () => {
    const first = msg({ msg_id: "a", sender_id: "u1", reply_to_msg_id: "root-a", created_at: "2026-08-09T10:00:00Z" });
    const next = msg({ msg_id: "b", sender_id: "u1", reply_to_msg_id: "root-b", created_at: "2026-08-09T10:01:00Z" });
    expect(isDiscussionConsecutive(first, next)).toBe(false);
  });
});
