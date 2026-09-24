import { describe, expect, it } from "vitest";
import { placeNearRect } from "./floating-layer";
import { isPointInSelection, quoteSelectedText } from "./context-actions";

describe("context action helpers", () => {
  it("formats every selected line as a markdown quote", () => {
    expect(quoteSelectedText("first\r\n\r\nthird")).toBe("> first\n> \n> third");
  });

  it("keeps a pointer menu inside the viewport", () => {
    const anchor = { left: 390, right: 390, top: 290, bottom: 290 } as DOMRect;
    expect(placeNearRect(anchor, 180, 120, "down", { width: 400, height: 300 })).toEqual({
      x: 212,
      y: 162,
    });
  });

  it("identifies if a point lands within an active text selection", () => {
    expect(isPointInSelection(null, 100, 100)).toBe(false);

    const mockSelectionCollapsed = {
      isCollapsed: true,
      rangeCount: 1,
      toString: () => "",
    } as unknown as Selection;
    expect(isPointInSelection(mockSelectionCollapsed, 100, 100)).toBe(false);

    const mockSelection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "hello world",
      getRangeAt: () => ({
        getClientRects: () => [
          { left: 50, right: 150, top: 20, bottom: 40 } as DOMRect,
        ],
      }),
    } as unknown as Selection;

    // Inside rect
    expect(isPointInSelection(mockSelection, 100, 30)).toBe(true);
    // Boundary tolerance (within 2px)
    expect(isPointInSelection(mockSelection, 49, 30)).toBe(true);
    // Clearly outside
    expect(isPointInSelection(mockSelection, 200, 30)).toBe(false);
    expect(isPointInSelection(mockSelection, 100, 80)).toBe(false);
  });
});
