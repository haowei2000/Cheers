import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InlineEditActions } from "./inline-edit-actions";

describe("InlineEditActions", () => {
  it("keeps the edit action next to its named object", () => {
    const markup = renderToStaticMarkup(
      <InlineEditActions label="channel purpose" editing={false} onEdit={() => {}} onSave={() => {}} onCancel={() => {}} />,
    );
    expect(markup).toContain("Edit channel purpose");
    expect(markup).toContain('data-button-content="icon"');
  });

  it("replaces edit with local cancel and save actions", () => {
    const markup = renderToStaticMarkup(
      <InlineEditActions label="channel purpose" editing onEdit={() => {}} onSave={() => {}} onCancel={() => {}} />,
    );
    expect(markup).toContain("Cancel editing channel purpose");
    expect(markup).toContain("Save channel purpose");
    expect(markup).not.toContain("Edit channel purpose");
  });
});
