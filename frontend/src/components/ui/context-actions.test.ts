import { describe, expect, it } from "vitest";
import { placeNearRect } from "./floating-layer";
import { quoteSelectedText } from "./context-actions";

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
});
