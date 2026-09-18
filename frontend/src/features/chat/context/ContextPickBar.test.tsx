import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ContextPickBar, ContextPickerButton } from "./ContextPickBar";
import { useContextPickStore } from "./contextPick";

const CHANNEL_ID = "channel-1";

describe("composer context controls", () => {
  beforeEach(() => {
    useContextPickStore.setState({ byChannel: {}, dismissed: {} });
  });

  it("does not reserve a context row when there are no picks or suggestions", () => {
    const markup = renderToStaticMarkup(<ContextPickBar channelId={CHANNEL_ID} />);

    expect(markup).toBe("");
  });

  it("renders Add context as a standalone regular toolbar control", () => {
    const markup = renderToStaticMarkup(<ContextPickerButton channelId={CHANNEL_ID} />);

    expect(markup).toContain("Add context");
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-control-size="regular"');
  });

  it("keeps suggested context in a separate row without the picker action", () => {
    const markup = renderToStaticMarkup(
      <ContextPickBar
        channelId={CHANNEL_ID}
        draftText="Please update the plan"
      />,
    );

    expect(markup).toContain("Plan");
    expect(markup).not.toContain("Add context");
  });
});
