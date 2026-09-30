import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocatorOpenContext } from "./messageLinks";
import { ResourceRefCards, resourceRefCards } from "./ResourceRefCards";

describe("resource reference cards", () => {
  it("keeps only supported versioned Cheers resource references", () => {
    const cards = resourceRefCards({ cards: [
      { v: 1, kind: "resource_ref", uri: "cheers:desk/notes.md#L3", title: "Notes" },
      { v: 1, kind: "resource_ref", uri: "cheers:msg/m-1" },
      { v: 1, kind: "resource_ref", uri: "javascript:alert(1)" },
    ] });
    expect(cards).toHaveLength(1);
    const markup = renderToStaticMarkup(
      <LocatorOpenContext.Provider value={vi.fn()}><ResourceRefCards cards={cards} /></LocatorOpenContext.Provider>,
    );
    expect(markup).toContain("Notes");
    expect(markup).toContain("cheers:desk/notes.md#L3");
    expect(markup).not.toContain("javascript:");
  });
});
