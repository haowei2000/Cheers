import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { messageDetailsMeta } from "./messageDetails";

const base = {
  msg_id: "message-1",
  channel_id: "channel-1",
  sender_type: "bot",
  sender_id: "bot-1",
  content: "Done",
  created_at: "2026-08-09T00:00:00Z",
} as Message;

describe("messageDetailsMeta", () => {
  it("hides Details when a message has no steps or context", () => {
    expect(messageDetailsMeta(base).hasDetails).toBe(false);
  });

  it("counts attached context without treating it as visible message body", () => {
    const meta = messageDetailsMeta({
      ...base,
      context_bundle: {
        items: [
          { verb: "message.read", label: "Message #3", kind: "message" },
          { verb: "message.read", label: "Message #4", kind: "message" },
        ],
      },
    });
    expect(meta).toMatchObject({ contextCount: 2, hasDetails: true });
  });

  it("merges persisted and live trace summaries and preserves failure status", () => {
    const meta = messageDetailsMeta({
      ...base,
      trace_count: 3,
      _trace_events: [
        {
          v: 1,
          id: "trace-1",
          msg_id: "message-1",
          channel_id: "channel-1",
          trace_seq: 1,
          kind: "trace",
          phase: "prompt_failed",
          status: "failed",
          is_terminal: true,
          created_at: "2026-08-09T00:00:01Z",
        },
      ],
    });
    expect(meta).toMatchObject({ traceCount: 3, hasTrace: true, hasFailure: true });
  });
});
