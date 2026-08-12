import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@/types";
import { BotTracePanel } from "./BotTracePanel";

const toolEvent: TraceEvent = {
  v: 1,
  id: "tool-1",
  event_id: "tool-1",
  msg_id: "message-1",
  channel_id: "channel-1",
  trace_seq: 1,
  kind: "trace",
  phase: "tool_call",
  status: "completed",
  is_terminal: true,
  created_at: "2026-08-12T07:44:00Z",
  data: {
    presentation: {
      v: 2,
      event_type: "file_read",
      family: "file",
      operation: "read",
      confidence: "explicit",
      matched_by: "test",
      path: "server/Cargo.toml",
    },
  },
};

describe("BotTracePanel disclosure labels", () => {
  it("shows the tool name and summary instead of the Expand action label", () => {
    const markup = renderToStaticMarkup(
      <BotTracePanel
        channelId="channel-1"
        msgId="message-1"
        liveEvents={[toolEvent]}
        expanded
        showToggle={false}
      />,
    );

    expect(markup).toContain(">Read<");
    expect(markup).toContain("server/Cargo.toml");
    expect(markup).toContain("Completed");
    expect(markup).not.toContain(">Expand<");
  });

  it("keeps Agent steps as the visible panel disclosure label", () => {
    const markup = renderToStaticMarkup(
      <BotTracePanel
        channelId="channel-1"
        msgId="message-1"
        liveEvents={[toolEvent]}
        expanded={false}
      />,
    );

    expect(markup).toContain("Agent steps");
    expect(markup).not.toContain(">Expand<");
  });
});
