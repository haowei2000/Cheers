import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollectionManagerDemo } from "./CollectionManagerDemo";
import { CollectionDeleteItem, CollectionEmptyItem } from "./collection-manager";

describe("CollectionManager pattern", () => {
  it("renders one toolbar and semantic operations rows", () => {
    const markup = renderToStaticMarkup(<CollectionManagerDemo />);
    expect(markup).toContain("Search claims and links");
    expect(markup).toContain("OpenCode task claiming");
    expect(markup).toContain("7-day invite link");
    expect(markup).toContain('data-item-kind="operations"');
  });

  it("keeps destructive confirmation as a composite row without nested buttons", () => {
    const markup = renderToStaticMarkup(
      <CollectionDeleteItem
        title="Delete item?"
        description="This cannot be undone."
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(markup).toContain("Delete?");
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Delete");
  });

  it("does not repeat the toolbar add action inside an empty row", () => {
    const markup = renderToStaticMarkup(<CollectionEmptyItem />);
    expect(markup).toContain("No items yet");
    expect(markup).not.toContain("<button");
  });
});
