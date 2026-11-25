import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { McpNarrowSwitch } from "./BotMcpPolicySection";

describe("McpNarrowSwitch", () => {
  it("spells out the state in words, not only the switch position", () => {
    const on = renderToStaticMarkup(<McpNarrowSwitch narrow busy={false} onChange={() => {}} />);
    expect(on).toContain('role="switch"');
    expect(on).toMatch(/<input[^>]*\schecked/);
    expect(on).toContain("only what that person could do");

    const off = renderToStaticMarkup(<McpNarrowSwitch narrow={false} busy={false} onChange={() => {}} />);
    expect(off).not.toMatch(/<input[^>]*\schecked/);
    expect(off).toContain("bot&#x27;s own role");
  });

  it("disables the switch while a change is saving", () => {
    const html = renderToStaticMarkup(<McpNarrowSwitch narrow busy onChange={() => {}} />);
    expect(html).toMatch(/<input[^>]*disabled/);
  });
});
