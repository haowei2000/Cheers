import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionButton } from "./action-button";

describe("ActionButton", () => {
  it("keeps full-form save visible and primary", () => {
    const markup = renderToStaticMarkup(
      <ActionButton action="save" context="form" accessibleLabel="Save profile" />,
    );
    expect(markup).toContain('aria-label="Save profile"');
    expect(markup).toContain('data-button-content="iconText"');
    expect(markup).toContain(">Save</span>");
    expect(markup).toContain('data-button-slot="icon"');
  });

  it("uses a contextual icon-only name for inline save", () => {
    const markup = renderToStaticMarkup(
      <ActionButton action="save" context="inlineEdit" accessibleLabel="Save channel purpose" />,
    );
    expect(markup).toContain('aria-label="Save channel purpose"');
    expect(markup).toContain('data-button-content="icon"');
    expect(markup).not.toContain('data-button-slot="label"');
  });

  it("keeps dialog cancel as a visible text action", () => {
    const markup = renderToStaticMarkup(<ActionButton action="cancel" context="dialog" />);
    expect(markup).toContain('data-button-content="text"');
    expect(markup).toContain("Cancel");
  });

  it("keeps destructive confirmation explicit", () => {
    const markup = renderToStaticMarkup(
      <ActionButton action="delete" context="confirmation" aria-label="Delete channel" />,
    );
    expect(markup).toContain('aria-label="Delete channel"');
    expect(markup).toContain('data-button-content="iconText"');
    expect(markup).toContain(">Delete</span>");
  });

  it("uses an icon-only close button for window chrome", () => {
    const markup = renderToStaticMarkup(
      <ActionButton action="close" context="windowChrome" accessibleLabel="Close settings" />,
    );
    expect(markup).toContain('aria-label="Close settings"');
    expect(markup).toContain('data-button-content="icon"');
  });
});
