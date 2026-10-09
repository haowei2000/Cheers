import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WindowChromeProvider } from "@/features/desktop/WindowChromeContext";
import { ChannelChrome, ChannelPanelSwitcher } from "./ChannelChrome";

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

  it("places open panel navigation in the shared channel header", () => {
    const markup = renderToStaticMarkup(
      <WindowChromeProvider placement="inline">
        <ChannelChrome
          title="release"
          isDm={false}
          actions={null}
          panelSwitcher={(
            <ChannelPanelSwitcher
              panels={["viewboard", "workbench"]}
              activePanel="workbench"
              onSelect={() => {}}
            />
          )}
        />
      </WindowChromeProvider>,
    );

    expect(markup).toContain('aria-label="Open channel panels"');
    expect(markup).toContain("ViewBoard");
    expect(markup).toContain("Workbench");
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
