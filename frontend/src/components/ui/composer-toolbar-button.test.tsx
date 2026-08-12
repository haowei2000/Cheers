import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerToolbarButton } from "./composer-toolbar-button";

describe("ComposerToolbarButton", () => {
  it("keeps text composer controls in one regular width slot", () => {
    const markup = renderToStaticMarkup(
      <ComposerToolbarButton>Long model name</ComposerToolbarButton>,
    );

    expect(markup).toContain('data-control-size="regular"');
    expect(markup).toContain("h-9");
    expect(markup).toContain("w-24");
    expect(markup).toContain("rounded-sm");
  });
});
