import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { mergeMessages, sortMessages, upsertMessage } from "./messageCollection";

const message = (msgId: string, channelSeq: number | null, content = msgId) =>
  ({ msg_id: msgId, channel_seq: channelSeq, content }) as Message;

describe("messageCollection", () => {
  it("keeps unsequenced streaming placeholders after persisted messages", () => {
    expect(sortMessages([message("stream", null), message("saved", 2)]).map((item) => item.msg_id))
      .toEqual(["saved", "stream"]);
  });

  it("reorders a placeholder when its final sequence arrives", () => {
    const result = upsertMessage(
      [message("older", 1), message("stream", null)],
      { msg_id: "stream", channel_seq: 2, content: "complete" },
    );
    expect(result.map((item) => item.msg_id)).toEqual(["older", "stream"]);
    expect(result[1].content).toBe("complete");
  });

  it("merges a history page without duplicating live messages", () => {
    const result = mergeMessages(
      [message("one", 1, "live")],
      [message("one", 1, "persisted"), message("two", 2)],
    );
    expect(result.map((item) => [item.msg_id, item.content])).toEqual([
      ["one", "persisted"],
      ["two", "two"],
    ]);
  });
});
