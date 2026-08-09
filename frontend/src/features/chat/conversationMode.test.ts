import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { layoutMessages } from "./conversationMode";

function message(input: Partial<Message> & Pick<Message, "msg_id">): Message {
  return {
    sender_id: "user",
    sender_type: "user",
    content: "",
    created_at: "2026-08-09T12:00:00Z",
    ...input,
  };
}

describe("conversation modes", () => {
  const root = message({ msg_id: "root", content: "Topic" });
  const later = message({
    msg_id: "later",
    sender_id: "other",
    content: "Later message",
    created_at: "2026-08-09T12:01:00Z",
  });
  const reply = message({
    msg_id: "reply",
    content: "Reply",
    reply_to_msg_id: "root",
    created_at: "2026-08-09T12:02:00Z",
  });

  it("keeps replies in chronological order for Chat", () => {
    const layout = layoutMessages([root, later, reply], "chat");
    expect(layout.topLevel.map((item) => item.msg_id)).toEqual([
      "root",
      "later",
      "reply",
    ]);
  });

  it("groups replies below their root for Discuss", () => {
    const layout = layoutMessages([root, later, reply], "discuss");
    expect(layout.topLevel.map((item) => item.msg_id)).toEqual(["root", "later"]);
    expect(layout.childrenByParent.get("root")?.map((item) => item.msg_id)).toEqual([
      "reply",
    ]);
  });
});
