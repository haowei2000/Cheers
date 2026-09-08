import { describe, expect, it } from "vitest";
import {
  activateCanvasNode,
  canvasNodeKeyAction,
  fitCanvasTransform,
  moveCanvasRectWithKeyboard,
  nextCanvasNodeId,
  removeCanvasNodeState,
} from "./viewTransform";

describe("canvas view transforms", () => {
  it("fits negative and distant nodes inside the viewport", () => {
    const viewport = { width: 800, height: 600 };
    const rects = [
      { x: -300, y: -120, w: 200, h: 100 },
      { x: 900, y: 620, w: 300, h: 180 },
    ];
    const fitted = fitCanvasTransform(rects, viewport);
    for (const rect of rects) {
      const left = rect.x * fitted.scale + fitted.offset.x;
      const top = rect.y * fitted.scale + fitted.offset.y;
      const right = (rect.x + rect.w) * fitted.scale + fitted.offset.x;
      const bottom = (rect.y + rect.h) * fitted.scale + fitted.offset.y;
      expect(left).toBeGreaterThanOrEqual(24);
      expect(top).toBeGreaterThanOrEqual(24);
      expect(right).toBeLessThanOrEqual(viewport.width - 24);
      expect(bottom).toBeLessThanOrEqual(viewport.height - 24);
    }
  });

  it("moves a focused node by the keyboard grid", () => {
    const rect = { x: 10, y: 20, w: 100, h: 80 };
    expect(moveCanvasRectWithKeyboard(rect, "ArrowRight")).toMatchObject({ x: 18, y: 20 });
    expect(moveCanvasRectWithKeyboard(rect, "ArrowUp", true)).toMatchObject({ x: 10, y: -12 });
  });

  it("maps every supported keyboard gesture to its canvas action", () => {
    expect(canvasNodeKeyAction("Enter", { writable: true })).toEqual({ kind: "activate" });
    expect(canvasNodeKeyAction(" ", { writable: true })).toEqual({ kind: "activate" });
    expect(canvasNodeKeyAction("Delete", { writable: true })).toEqual({ kind: "remove" });
    expect(canvasNodeKeyAction("Backspace", { writable: false })).toBeNull();
    expect(canvasNodeKeyAction("ArrowLeft", { writable: true })).toEqual({ kind: "focus", delta: -1 });
    expect(canvasNodeKeyAction("ArrowDown", { writable: true })).toEqual({ kind: "focus", delta: 1 });
    expect(canvasNodeKeyAction("ArrowUp", { altKey: true, shiftKey: true, writable: true })).toEqual({
      kind: "move", key: "ArrowUp", largeStep: true,
    });
    expect(canvasNodeKeyAction("ArrowUp", { altKey: true, writable: false })).toEqual({
      kind: "focus", delta: -1,
    });
    expect(canvasNodeKeyAction("x", { writable: true })).toBeNull();
  });

  it("wraps roving focus in document order", () => {
    expect(nextCanvasNodeId(["a", "b", "c"], "a", -1)).toBe("c");
    expect(nextCanvasNodeId(["a", "b", "c"], "c", 1)).toBe("a");
    expect(nextCanvasNodeId(["a", "b"], "missing", 1)).toBe("a");
  });

  it("uses the same activation for selection and keyboard edge creation", () => {
    expect(activateCanvasNode(null, null, "a")).toEqual({
      selectedId: "a", connectingFromId: null, connection: null,
    });
    expect(activateCanvasNode("a", null, "a")).toEqual({
      selectedId: null, connectingFromId: null, connection: null,
    });
    expect(activateCanvasNode("a", "a", "b")).toEqual({
      selectedId: "b", connectingFromId: null, connection: { from: "a", to: "b" },
    });
  });

  it("cancels connection mode when its source is removed and rejects stale endpoints", () => {
    expect(removeCanvasNodeState("a", "a", "a")).toEqual({
      selectedId: null, connectingFromId: null,
    });
  });
});
