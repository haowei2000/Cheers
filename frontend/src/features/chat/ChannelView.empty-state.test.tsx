import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelSelectionState } from "./ChannelView";

describe("ChannelView workspace transitions", () => {
  it("does not expose the inline sidebar toggle while the next workspace is loading", () => {
    const markup = renderToStaticMarkup(
      <ChannelSelectionState
        pending
        sidebarToggle={<button aria-label="Hide sidebar">Toggle</button>}
      />,
    );

    expect(markup).toContain('aria-label="Loading channels"');
    expect(markup).not.toContain('aria-label="Hide sidebar"');
    expect(markup).not.toContain("Select a channel to start chatting");
  });
});
