import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostItem, hostIndicator, type HostItemData } from "./HostItem";

const host: HostItemData = {
  bot_id: "bot-1",
  bot_name: "OpenCode",
  host_id: "host-1",
  device_name: "My Mac",
  agent_type: "opencode",
  credential_prefix: "agbi_privateprefix",
  created_at: "2026-09-06T10:00:00Z",
  status: "active",
  online: false,
  mcp_connection_state: "unconfigured",
};

describe("HostItem", () => {
  it("offers one accessible detail action and moves diagnostic text out of the row", () => {
    const html = renderToStaticMarkup(
      <HostItem item={host} onChanged={() => {}} />,
    );
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toContain("View host My Mac for OpenCode");
    expect(html).toContain("Offline");
    expect(html).not.toContain(host.credential_prefix);
    expect(html).not.toContain(host.created_at);
    expect(html).not.toContain("Last seen");
  });
  it("retains an actionable sign-in warning even in the compact row", () => {
    const html = renderToStaticMarkup(
      <HostItem
        item={{ ...host, mcp_connection_state: "refresh_failed" }}
        onChanged={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Sign-in expired"');
    expect(html.match(/<button\b/g)).toHaveLength(1);
  });
  it("does not mistake a revoked or unpaired device for a usable online host", () => {
    expect(
      hostIndicator({ ...host, online: true, revoked_at: host.created_at })
        .label,
    ).toBe("Revoked");
    expect(
      hostIndicator({ ...host, online: true, status: "pending" }).label,
    ).toBe("Pairing");
    expect(hostIndicator({ ...host, online: true }).label).toBe("Online");
    expect(hostIndicator({ ...host, status: "standby" }).label).toBe("Standby");
  });
});
