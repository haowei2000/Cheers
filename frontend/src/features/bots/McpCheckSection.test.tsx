import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { McpCheckReport } from "@/api/bots";
import { McpCheckResults, McpCheckSection } from "./McpCheckSection";

const report: McpCheckReport = {
  status: "fail",
  checked_at: "2026-09-15T12:00:00Z",
  layers: [
    {
      id: "gateway",
      title: "Gateway",
      status: "warn",
      checks: [
        {
          id: "endpoint",
          label: "Endpoint",
          status: "warn",
          summary: "Only agents on the gateway's own machine can reach this address",
          detail: "http://localhost:30080/mcp",
          hint: "Set MCP_PUBLIC_URL to an HTTPS address when agents run on other devices.",
        },
      ],
    },
    {
      id: "agent",
      title: "Agent",
      status: "fail",
      checks: [
        {
          id: "sign_in",
          label: "Sign-in",
          status: "fail",
          summary: "Cheers rejected the agent's MCP requests",
          detail: "MCP-Protocol-Version header is required (-32020)",
          hint: "Update Codex, then start a new session.",
          observed_at: "2026-09-15T11:55:00Z",
        },
        {
          id: "protocol",
          label: "Protocol",
          status: "skip",
          summary: "Known after the agent's first request",
        },
      ],
    },
  ],
};

describe("McpCheckSection", () => {
  it("offers one labelled Check action before anything has run", () => {
    const html = renderToStaticMarkup(
      <McpCheckSection botId="bot-1" hostId="host-1" deviceName="My Mac" />,
    );
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Check Cheers MCP for My Mac"');
    expect(html).toContain("Cheers MCP");
    expect(html).not.toContain('role="status"');
  });

  it("groups findings by layer with an accessible verdict, the evidence, and the fix", () => {
    const html = renderToStaticMarkup(<McpCheckResults report={report} />);
    expect(html).toContain("Cheers MCP is not working");
    expect(html).toContain("Gateway");
    expect(html).toContain("Agent");
    expect(html).toContain('aria-label="Needs attention"');
    expect(html).toContain('aria-label="Failed"');
    expect(html).toContain('aria-label="Not applicable"');
    expect(html).toContain("MCP-Protocol-Version header is required (-32020)");
    expect(html).toContain("Update Codex, then start a new session.");
    // Verdicts are presented in words, never as raw status values.
    expect(html).not.toMatch(/>(pass|warn|fail|skip)</);
  });
});
