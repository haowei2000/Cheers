import type { CanvasRect } from "./document";

export interface CanvasViewTransform {
  scale: number;
  offset: { x: number; y: number };
}

export type CanvasArrowKey = "ArrowUp" | "ArrowRight" | "ArrowDown" | "ArrowLeft";

export type CanvasNodeKeyAction =
  | { kind: "activate" }
  | { kind: "remove" }
  | { kind: "focus"; delta: -1 | 1 }
  | { kind: "move"; key: CanvasArrowKey; largeStep: boolean };

export interface CanvasNodeActivation {
  selectedId: string | null;
  connectingFromId: string | null;
  connection: { from: string; to: string } | null;
}

/** Turn browser key state into the complete keyboard contract for a canvas node.
 * Keeping this decision pure makes the non-pointer path independently testable. */
export function canvasNodeKeyAction(
  key: string,
  options: { altKey?: boolean; shiftKey?: boolean; writable: boolean }
): CanvasNodeKeyAction | null {
  if (key === "Enter" || key === " ") return { kind: "activate" };
  if (key === "Delete" || key === "Backspace") return options.writable ? { kind: "remove" } : null;
  if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(key)) return null;
  const arrow = key as CanvasArrowKey;
  if (options.altKey) {
    return options.writable
      ? { kind: "move", key: arrow, largeStep: !!options.shiftKey }
      : { kind: "focus", delta: arrow === "ArrowLeft" || arrow === "ArrowUp" ? -1 : 1 };
  }
  return { kind: "focus", delta: arrow === "ArrowLeft" || arrow === "ArrowUp" ? -1 : 1 };
}

export function nextCanvasNodeId(ids: readonly string[], currentId: string, delta: -1 | 1): string | null {
  if (ids.length === 0) return null;
  const current = ids.indexOf(currentId);
  if (current < 0) return ids[0] ?? null;
  return ids[(current + delta + ids.length) % ids.length] ?? null;
}

/** Apply Enter/Space or a pointer click with identical select/connect semantics. */
export function activateCanvasNode(
  selectedId: string | null,
  connectingFromId: string | null,
  targetId: string
): CanvasNodeActivation {
  if (connectingFromId && connectingFromId !== targetId) {
    return {
      selectedId: targetId,
      connectingFromId: null,
      connection: { from: connectingFromId, to: targetId },
    };
  }
  return {
    selectedId: selectedId === targetId ? null : targetId,
    connectingFromId,
    connection: null,
  };
}

export function removeCanvasNodeState(
  selectedId: string | null,
  connectingFromId: string | null,
  removedId: string
): Pick<CanvasNodeActivation, "selectedId" | "connectingFromId"> {
  return {
    selectedId: selectedId === removedId ? null : selectedId,
    connectingFromId: connectingFromId === removedId ? null : connectingFromId,
  };
}

/** Center every node inside the viewport with a stable screen-space inset. */
export function fitCanvasTransform(
  rects: readonly CanvasRect[],
  viewport: { width: number; height: number },
  padding = 24,
  maxScale = 2.2
): CanvasViewTransform {
  if (rects.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { scale: 1, offset: { x: padding, y: padding } };
  }
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  const contentWidth = Math.max(maxX - minX, 1);
  const contentHeight = Math.max(maxY - minY, 1);
  const availableWidth = Math.max(viewport.width - padding * 2, 1);
  const availableHeight = Math.max(viewport.height - padding * 2, 1);
  const scale = Math.min(maxScale, availableWidth / contentWidth, availableHeight / contentHeight);
  return {
    scale,
    offset: {
      x: (viewport.width - contentWidth * scale) / 2 - minX * scale,
      y: (viewport.height - contentHeight * scale) / 2 - minY * scale,
    },
  };
}

export function moveCanvasRectWithKeyboard(
  rect: CanvasRect,
  key: CanvasArrowKey,
  largeStep = false
): CanvasRect {
  const step = largeStep ? 32 : 8;
  switch (key) {
    case "ArrowUp": return { ...rect, y: rect.y - step };
    case "ArrowRight": return { ...rect, x: rect.x + step };
    case "ArrowDown": return { ...rect, y: rect.y + step };
    case "ArrowLeft": return { ...rect, x: rect.x - step };
  }
}
