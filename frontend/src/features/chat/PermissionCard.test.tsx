import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { PermissionCard } from "./PermissionCard";

const permission: Message = {
  msg_id: "permission-1",
  sender_id: "bot-1",
  sender_type: "bot",
  content: "Approval needed",
  msg_type: "permission",
    content_data: {
    kind: "agent_bridge_permission_request",
    request_id: "request-1",
    title: "Publish frontend changes",
    resolved: false,
      bot_owner_id: "user-1",
      body: "This command pushes the current branch to the remote repository.",
      tool: {
        title: "Git push",
        command: "git push origin codex/fix-inline-workspace-links",
      },
    options: [
      { option_id: "allow-once", kind: "allow_once", name: "Allow once", description: "Run this command once." },
      { option_id: "allow-always", kind: "allow_always", name: "Always allow" },
      { option_id: "reject-once", kind: "reject_once", name: "Deny" },
    ],
  },
};

describe("PermissionCard options", () => {
  it("renders every ACP option as one direct action without an extra approval footer", () => {
    const markup = renderToStaticMarkup(
      <PermissionCard
        message={permission}
        channelId="channel-1"
        currentUserId="user-1"
        approverOverride
        embedded
      />,
    );

    expect(markup).toContain("Allow once");
    expect(markup).toContain("Always allow");
    expect(markup).toContain("Deny");
    expect(markup).not.toContain(">Approve<");
    expect(markup).not.toContain(">Reject<");
    expect(markup).not.toContain('role="option"');
  });

  it("keeps the inline approval to one summary, one command, and direct actions", () => {
    const markup = renderToStaticMarkup(
      <PermissionCard
        message={permission}
        channelId="channel-1"
        currentUserId="user-1"
        approverOverride
        embedded
        compact
      />,
    );

    expect(markup.match(/Publish frontend changes/g)).toHaveLength(1);
    expect(markup).toContain("Needs approval");
    expect(markup).toContain("git push origin codex/fix-inline-workspace-links");
    expect(markup).not.toContain("This command pushes the current branch");
    expect(markup).not.toContain("Run this command once");
    expect(markup).not.toContain(">Git push<");
  });
});
