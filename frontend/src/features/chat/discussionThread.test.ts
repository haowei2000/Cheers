import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import {
  inDiscussionThread,
  mergeDiscussionMessages,
} from "./discussionThread";

function message(input: Partial<Message> & Pick<Message, "msg_id">): Message {
  return {
    sender_id: "user",
    sender_type: "user",
    content: "",
    created_at: "2026-08-17T12:00:00Z",
    ...input,
  };
}

describe("discussionThread", () => {
  const root = message({ msg_id: "root", content: "Topic", channel_seq: 1 });

  it("treats the root and thread_root replies as in-thread", () => {
    expect(inDiscussionThread(root, "root")).toBe(true);
    expect(
      inDiscussionThread(
        message({ msg_id: "r1", thread_root_msg_id: "root", reply_to_msg_id: "root" }),
        "root",
      ),
    ).toBe(true);
    expect(
      inDiscussionThread(message({ msg_id: "other", thread_root_msg_id: "else" }), "root"),
    ).toBe(false);
  });

  it("overlays live partials and nested replies that REST has not returned yet", () => {
    const restReply = message({
      msg_id: "human",
      reply_to_msg_id: "root",
      thread_root_msg_id: "root",
      content: "Hello",
      channel_seq: 2,
    });
    const livePartial = message({
      msg_id: "bot",
      sender_type: "bot",
      reply_to_msg_id: "human",
      content: "Work",
      is_partial: true,
      channel_seq: 3,
    });
    const merged = mergeDiscussionMessages(root, [restReply], [livePartial]);
    expect(merged.map((item) => item.msg_id)).toEqual(["root", "human", "bot"]);
    expect(merged.find((item) => item.msg_id === "bot")?.is_partial).toBe(true);
  });

  it("walks reply_to so nested live rows join without thread_root_msg_id", () => {
    const human = message({
      msg_id: "human",
      reply_to_msg_id: "root",
      thread_root_msg_id: "root",
      channel_seq: 2,
    });
    const bot = message({
      msg_id: "bot",
      sender_type: "bot",
      reply_to_msg_id: "human",
      content: "Working",
      is_partial: true,
      channel_seq: 3,
    });
    const nested = message({
      msg_id: "nested",
      reply_to_msg_id: "bot",
      content: "ack",
      channel_seq: 4,
    });
    const merged = mergeDiscussionMessages(root, [human], [bot, nested]);
    expect(merged.map((item) => item.msg_id)).toEqual([
      "root",
      "human",
      "bot",
      "nested",
    ]);
  });

  it("lets a later live row replace a REST reply", () => {
    const restReply = message({
      msg_id: "human",
      reply_to_msg_id: "root",
      thread_root_msg_id: "root",
      content: "Hello",
      channel_seq: 2,
    });
    const live = message({
      msg_id: "human",
      reply_to_msg_id: "root",
      thread_root_msg_id: "root",
      content: "Hello edited",
      channel_seq: 2,
    });
    const merged = mergeDiscussionMessages(root, [restReply], [live]);
    expect(merged.find((item) => item.msg_id === "human")?.content).toBe("Hello edited");
  });
});
