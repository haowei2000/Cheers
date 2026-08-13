import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { AgentInteractionCard } from "./AgentInteractionCard";

/** Creates the common persisted-message envelope used by both interaction sources. */
function interactionMessage(msgType: "elicitation" | "auth_required"): Message {
  return {
    msg_id: `${msgType}-1`,
    sender_id: "bot-1",
    sender_type: "bot",
    content: "Agent interaction",
    msg_type: msgType,
    content_data: msgType === "elicitation"
      ? {
          request_id: "request-1",
          mode: "url",
          interaction_kind: "mcp_oauth",
          message: "Authorize Cheers tools",
          url: "https://cheers.example/oauth/authorize",
          initiating_user_id: "user-1",
        }
      : {
          request_id: "request-2",
          bot_owner_id: "user-1",
          name: "Sign in required",
          agent_profile: {
            id: "codex",
            display_name: "Codex",
            login_hint: "Run the native login command.",
          },
        },
  };
}

describe("AgentInteractionCard", () => {
  it("renders ACP elicitation through the unified boundary", () => {
    const markup = renderToStaticMarkup(
      <AgentInteractionCard
        message={interactionMessage("elicitation")}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );

    expect(markup).toContain("Connect Cheers MCP");
    expect(markup).toContain("cheers.example");
  });

  it("renders runtime auth diagnostics through the same boundary", () => {
    const markup = renderToStaticMarkup(
      <AgentInteractionCard
        message={interactionMessage("auth_required")}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );

    expect(markup).toContain("Sign in required");
    expect(markup).toContain("Run the native login command.");
  });
});
