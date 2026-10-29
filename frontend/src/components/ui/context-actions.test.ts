import { createElement, type MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeNearRect } from "./floating-layer";
import { quoteSelectedText, useContextSurface } from "./context-actions";

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

// Exercise the hook's event handlers without adding a DOM runtime to Vitest.
class SurfaceElement {
  constructor(private nativeMenu = false, private code = false) {}
  closest(selector: string) {
    return (selector === "pre, code" ? this.code : this.nativeMenu) ? this : null;
  }
  contains(node: unknown) { return node === this; }
}

function contextGesture({ selected = true, code = false, nativeMenu = false, outside = false } = {}) {
  const surface = new SurfaceElement(false, code);
  const target = nativeMenu ? new SurfaceElement(true) : surface;
  const rangeNode = outside ? new SurfaceElement() : surface;
  const rect = { left: 50, right: 150, top: 20, bottom: 40, width: 100, height: 20 };
  const getSelection = vi.fn(() => selected ? {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => "selected message text",
    getRangeAt: () => ({
      startContainer: rangeNode,
      endContainer: rangeNode,
      commonAncestorContainer: rangeNode,
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect],
    }),
  } : null);
  vi.stubGlobal("Element", SurfaceElement);
  vi.stubGlobal("window", { getSelection });
  vi.stubGlobal("DOMRect", class {
    constructor(public x: number, public y: number, public width: number, public height: number) {}
  });
  const actions = vi.fn(() => [{ id: "reply", label: "Reply", run: vi.fn() }]);
  const selectionActions = vi.fn(() => [{ id: "copy-selection", label: "Copy selection", run: vi.fn() }]);
  let handlers!: ReturnType<typeof useContextSurface>;
  function Harness() {
    handlers = useContextSurface({
      surfaceRef: { current: surface as unknown as HTMLElement },
      actions,
      selectionActions,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  const event = {
    target,
    clientX: 100,
    clientY: 30,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  handlers.onContextMenu(event as unknown as MouseEvent<HTMLElement>);
  return { actions, selectionActions, event, getSelection };
}

describe("context surface right-click", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])("opens application actions on selected text (code: %s)", (code) => {
    const { actions, selectionActions, event } = contextGesture({ code });
    expect(selectionActions).toHaveBeenCalledWith(expect.objectContaining({
      text: "selected message text", isCode: code,
    }));
    expect(actions).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("uses message actions when there is no text selection", () => {
    const { actions, selectionActions, event } = contextGesture({ selected: false });
    expect(actions).toHaveBeenCalledOnce();
    expect(selectionActions).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not apply a selection belonging to another surface", () => {
    const { actions, selectionActions, event } = contextGesture({ outside: true });
    expect(actions).toHaveBeenCalledOnce();
    expect(selectionActions).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("preserves native menus on editable fields and other native targets", () => {
    const { actions, selectionActions, event, getSelection } = contextGesture({ nativeMenu: true });
    expect(getSelection).not.toHaveBeenCalled();
    expect(actions).not.toHaveBeenCalled();
    expect(selectionActions).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
