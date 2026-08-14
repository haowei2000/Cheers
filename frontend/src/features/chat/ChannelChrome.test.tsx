import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WindowChromeProvider } from "@/features/desktop/WindowChromeContext";
import { ChannelChrome } from "./ChannelChrome";

describe("ChannelChrome", () => {
  it("renders the channel header and actions in inline shells", () => {
    const markup = renderToStaticMarkup(
      <WindowChromeProvider placement="inline">
        <ChannelChrome
          title="release"
          purpose="Ship coordination"
          isDm={false}
          actions={<span data-channel-action="files">Files</span>}
        />
      </WindowChromeProvider>,
    );

    expect(markup).toContain("release");
    expect(markup).toContain("Ship coordination");
    expect(markup).toContain("Files");
  });

  it("does not render a second inline header in window chrome shells", () => {
    const markup = renderToStaticMarkup(
      <WindowChromeProvider placement="window">
        <ChannelChrome
          title="release"
          isDm={false}
          actions={<span data-channel-action="files">Files</span>}
        />
      </WindowChromeProvider>,
    );

    expect(markup).toBe("");
  });
});
