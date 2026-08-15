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

  it("uses labelled icon-only actions in toolbars", () => {
    const markup = renderToStaticMarkup(
      <ActionButton action="add" context="toolbar" accessibleLabel="Add bot" />,
    );
    expect(markup).toContain('aria-label="Add bot"');
    expect(markup).toContain('title="Add bot"');
    expect(markup).toContain('data-button-content="icon"');
    expect(markup).not.toContain('data-button-slot="label"');
  });

  it("keeps disabled security actions labelled and legible", () => {
    const markup = renderToStaticMarkup(
      <ActionButton
        action="update"
        context="security"
        accessibleLabel="Update account password"
        disabled
      />,
    );
    expect(markup).toContain('data-button-content="iconText"');
    expect(markup).toContain(">Update</span>");
    expect(markup).toContain("font-utility");
    expect(markup).toContain("text-regular");
    expect(markup).toContain("bg-emphasis");
    expect(markup).toContain("text-content-on-accent");
    expect(markup).not.toContain("bg-indigo-100");
    expect(markup).toContain("disabled:opacity-50");
  });

  it("keeps settings actions on dark surfaces", () => {
    const enable = renderToStaticMarkup(
      <ActionButton action="enable" context="settings" accessibleLabel="Turn on notifications" />,
    );
    const retry = renderToStaticMarkup(
      <ActionButton action="retry" context="settings" />,
    );
    expect(enable).toContain("bg-emphasis");
    expect(enable).toContain("text-content-on-accent");
    expect(enable).not.toContain("text-content-on-light");
    expect(retry).toContain("bg-zinc-800");
  });

  it("uses secondary and danger tones for security row actions", () => {
    const link = renderToStaticMarkup(
      <ActionButton action="link" context="security" accessibleLabel="Link Google" />,
    );
    const unlink = renderToStaticMarkup(
      <ActionButton action="unlink" context="security" accessibleLabel="Unlink Google" />,
    );
    expect(link).toContain("bg-zinc-800");
    expect(link).toContain(">Link</span>");
    expect(unlink).toContain("text-danger-400");
    expect(unlink).toContain(">Unlink</span>");
  });
});
