import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelWorkspace } from "./PanelWorkspace";

describe("PanelWorkspace", () => {
  it("lets the conversation pane shrink before its message list scrolls", () => {
    const markup = renderToStaticMarkup(
      <PanelWorkspace
        channelId="channel-1"
        openPanels={[]}
        panels={null}
        onLaneElement={() => {}}
      >
        <div>Conversation</div>
      </PanelWorkspace>,
    );

    expect(markup).toContain(
      'data-workspace-messages="" class="flex min-h-0 min-w-0 flex-1 flex-col"',
    );
  });

  it("renders dock container when open panels are provided", () => {
    const markup = renderToStaticMarkup(
      <PanelWorkspace
        channelId="channel-1"
        openPanels={[{ id: "workbench", label: "Workbench" }]}
        panels={<div data-testid="panel-content">Workbench Content</div>}
        onLaneElement={() => {}}
      >
        <div>Conversation</div>
      </PanelWorkspace>,
    );

    expect(markup).toContain('data-workspace-dock=""');
    expect(markup).not.toContain('data-workspace-expanded="true"');
    expect(markup).toContain("Workbench Content");
  });
  it("places panel navigation in the channel header without duplicating dock tabs", () => {
    const markup = renderToStaticMarkup(
      <PanelWorkspace
        channelId="header-preview"
        openPanels={[{ id: "workbench", label: "Workbench" }, { id: "files", label: "Files" }]}
        panels={<div>Panel body</div>}
        onLaneElement={() => {}}
        header={(navigation) => <header>Channel name{navigation}</header>}
      >Conversation</PanelWorkspace>,
    );
    expect(markup.match(/aria-label="Workspace panels"/g)).toHaveLength(1);
    expect(markup.indexOf('aria-label="Workspace panels"')).toBeLessThan(markup.indexOf('</header>'));
    expect(markup).not.toContain('aria-label="Conversation view"');
  });

});
