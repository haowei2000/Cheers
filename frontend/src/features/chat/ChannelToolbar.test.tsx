import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelToolbar } from "./ChannelToolbar";

const defaultProps = {
  channelId: "test-channel",
  isDm: false,
  memberCount: 5,
  onlineCount: 2,
  filesOpen: false,
  workspaceOpen: false,
  viewBoardOpen: false,
  workbenchOpen: true,
  onManage: () => {},
  onToggleFiles: () => {},
  onToggleWorkspace: () => {},
  onToggleViewBoard: () => {},
  onToggleWorkbench: () => {},
  boards: [],
  onOpenBoard: () => {},
};

describe("ChannelToolbar", () => {
  it("renders roster button with count and aria labels", () => {
    const markup = renderToStaticMarkup(<ChannelToolbar {...defaultProps} />);

    expect(markup).toContain("ROSTER");
    expect(markup).toContain('aria-label="Channel roster: 5 members, 2 online"');
  });

  it("renders panels toggle button with active state when workbench is open", () => {
    const markup = renderToStaticMarkup(<ChannelToolbar {...defaultProps} />);

    expect(markup).toContain('aria-label="Panels"');
    expect(markup).toContain('data-selected="true"');
  });

  it("omits layout actions section from panels popover", () => {
    const markup = renderToStaticMarkup(<ChannelToolbar {...defaultProps} />);

    expect(markup).not.toContain("Save layout for channel");
    expect(markup).not.toContain("Reset to channel layout");
  });

  it("renders channel settings button in non-DM channels", () => {
    const markup = renderToStaticMarkup(<ChannelToolbar {...defaultProps} />);

    expect(markup).toContain('aria-label="Channel settings"');
  });

  it("omits channel settings button in DM channels", () => {
    const markup = renderToStaticMarkup(<ChannelToolbar {...defaultProps} isDm={true} />);

    expect(markup).not.toContain('aria-label="Channel settings"');
  });
});
