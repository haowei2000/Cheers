import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollectionManagerDemo } from "./CollectionManagerDemo";
import {
  CollectionConfirmationItem,
  CollectionDeleteItem,
  CollectionEmptyItem,
  CollectionManager,
} from "./collection-manager";

describe("CollectionManager pattern", () => {
  it("renders one toolbar and semantic operations rows", () => {
    const markup = renderToStaticMarkup(<CollectionManagerDemo />);
    expect(markup).toContain("Search claims and links");
    expect(markup).toContain("OpenCode task claiming");
    expect(markup).toContain("7-day invite link");
    expect(markup).toContain('data-item-kind="operations"');
  });

  it("reuses the confirmation row for non-delete destructive actions", () => {
    const markup = renderToStaticMarkup(
      <CollectionConfirmationItem
        title="Remembered device"
        description="The device will verify again."
        action="revoke"
        prompt="Revoke?"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(markup).toContain("Revoke?");
    expect(markup).toContain("Revoke");
    expect(markup.match(/<button/g)).toHaveLength(2);
  });

  it("keeps unlink inside the same explicit confirmation row", () => {
    const markup = renderToStaticMarkup(
      <CollectionConfirmationItem
        title="GitHub"
        description="Other devices will be signed out."
        action="unlink"
        prompt="Unlink?"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain("Unlink?");
    expect(markup).toContain(">Unlink</span>");
    expect(markup.match(/<button/g)).toHaveLength(2);
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

  it("renders resting state with icon buttons and without input field", () => {
    const markup = renderToStaticMarkup(
      <CollectionManager
        label="Members"
        count={3}
        query=""
        onQueryChange={() => undefined}
        searchPlaceholder="Search members"
        addLabel="Add member"
        onAdd={() => undefined}
      >
        <div>Item</div>
      </CollectionManager>,
    );
    expect(markup).toContain("Members");
    expect(markup).toContain("3");
    expect(markup).toContain("Search members");
    expect(markup).toContain("Add member");
    expect(markup).not.toContain("<input");
  });

  it("renders active search row with input field and close button when query is present", () => {
    const markup = renderToStaticMarkup(
      <CollectionManager
        label="Members"
        count={3}
        query="Alice"
        onQueryChange={() => undefined}
        searchPlaceholder="Search members"
        addLabel="Add member"
        onAdd={() => undefined}
      >
        <div>Item</div>
      </CollectionManager>,
    );
    expect(markup).toContain("<input");
    expect(markup).toContain('value="Alice"');
    expect(markup).toContain("Close search");
    expect(markup).toContain("Add member");
  });
});
