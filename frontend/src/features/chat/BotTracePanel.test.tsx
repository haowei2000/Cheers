import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message, TraceEvent } from "@/types";
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

const secondToolEvent: TraceEvent = {
  ...toolEvent,
  id: "tool-2",
  event_id: "tool-2",
  trace_seq: 2,
  data: {
    presentation: {
      v: 2,
      event_type: "shell_command",
      family: "shell",
      operation: "run",
      confidence: "explicit",
      matched_by: "test",
      command: "npm run typecheck",
    },
  },
};

const pendingApproval: Message = {
  msg_id: "permission-1",
  sender_id: "bot-1",
  sender_type: "bot",
  msg_type: "permission",
  content: "Approval needed",
  content_data: {
    kind: "agent_bridge_permission_request",
    request_id: "request-1",
    source_msg_id: "message-1",
    title: "Publish frontend changes",
    body: "This command pushes the current branch to the remote repository.",
    tool: { title: "Git push", command: "git push origin feature" },
    bot_owner_id: "user-1",
    resolved: false,
    options: [{ option_id: "allow-once", kind: "allow_once", name: "Allow once" }],
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

  it("keeps completed history out of the inline message surface", () => {
    const markup = renderToStaticMarkup(
      <BotTracePanel
        channelId="channel-1"
        msgId="message-1"
        liveEvents={[toolEvent, secondToolEvent]}
        expanded
        showToggle={false}
        view="inline"
      />,
    );

    expect(markup).not.toContain("server/Cargo.toml");
    expect(markup).not.toContain("npm run typecheck");
  });

  it("shows only the latest live step inline while streaming", () => {
    const markup = renderToStaticMarkup(
      <BotTracePanel
        channelId="channel-1"
        msgId="message-1"
        liveEvents={[toolEvent, secondToolEvent]}
        streaming
        expanded
        showToggle={false}
        view="inline"
      />,
    );

    expect(markup).not.toContain("server/Cargo.toml");
    expect(markup).toContain("npm run typecheck");
  });

  it("renders an inline approval without a duplicate trace header", () => {
    const markup = renderToStaticMarkup(
      <BotTracePanel
        channelId="channel-1"
        msgId="message-1"
        pendingApprovals={[pendingApproval]}
        currentUserId="user-1"
        expanded
        showToggle={false}
        view="inline"
      />,
    );

    expect(markup.match(/Publish frontend changes/g)).toHaveLength(1);
    expect(markup).toContain("Needs approval");
  });

  it("renders MCP startup failure with terminal login command hint", () => {
    const mcpStartupEvent: TraceEvent = {
      v: 1,
      id: "mcp-err-1",
      event_id: "mcp-err-1",
      msg_id: "message-1",
      channel_id: "channel-1",
      trace_seq: 1,
      kind: "trace",
      phase: "tool_call",
      tool_call_id: "mcp_startup.cheers",
      status: "failed",
      is_terminal: true,
      created_at: "2026-08-17T03:39:46Z",
      data: {
        content: [
          {
            content: {
              text: "[codex-acp forwarded startup error] MCP server `cheers` failed to start: MCP client for `cheers` failed to start",
            },
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <BotTracePanel
        channelId="channel-1"
        msgId="message-1"
        liveEvents={[mcpStartupEvent]}
        expanded
        showToggle={false}
      />,
    );

    expect(markup).toContain("MCP login required");
    expect(markup).toContain("codex mcp login cheers");
    expect(markup).not.toContain("rmcp::transport");
  });
});

