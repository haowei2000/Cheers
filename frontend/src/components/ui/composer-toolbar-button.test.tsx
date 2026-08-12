import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerToolbarButton } from "./composer-toolbar-button";

describe("ComposerToolbarButton", () => {
  it("keeps icon-text composer controls in one regular width slot", () => {
    const markup = renderToStaticMarkup(
      <ComposerToolbarButton><span aria-hidden>+</span><span>Model</span></ComposerToolbarButton>,
    );

    expect(markup).toContain('data-control-size="regular"');
    expect(markup).toContain("h-9");
    expect(markup).toContain('data-button-content="iconText"');
    expect(markup).toContain("w-32");
    expect(markup).toContain("rounded-sm");
  });
});
