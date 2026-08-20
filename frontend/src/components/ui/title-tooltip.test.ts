import { describe, expect, it } from "vitest";
import {
  captureTitle,
  resolveTitleTooltipAlign,
  restoreTitle,
} from "./title-tooltip";
import { contrastTooltipSurfaceClasses } from "./tooltip-surface";

function fakeElement(attributes: Record<string, string>) {
  const values = new Map(Object.entries(attributes));
  return {
    getAttribute: (name: string) => values.get(name) ?? null,
    setAttribute: (name: string, value: string) => values.set(name, value),
    removeAttribute: (name: string) => values.delete(name),
    hasAttribute: (name: string) => values.has(name),
  } as unknown as HTMLElement;
}

describe("global title tooltips", () => {
  it("temporarily suppresses the native title and restores accessibility metadata", () => {
    const anchor = fakeElement({ title: "Pin chat", "aria-describedby": "existing-help" });
    const captured = captureTitle(anchor, "contrast-tip");

    expect(captured?.text).toBe("Pin chat");
    expect(anchor.getAttribute("title")).toBeNull();
    expect(anchor.getAttribute("aria-describedby")).toBe("contrast-tip");

    restoreTitle(captured!, "contrast-tip");
    expect(anchor.getAttribute("title")).toBe("Pin chat");
    expect(anchor.getAttribute("aria-describedby")).toBe("existing-help");
  });

  it("aligns toward available viewport space", () => {
    expect(resolveTitleTooltipAlign(20, 60, 1200)).toBe("start");
    expect(resolveTitleTooltipAlign(500, 540, 1200)).toBe("center");
    expect(resolveTitleTooltipAlign(1140, 1180, 1200)).toBe("end");
  });

  it("uses a fixed dark-on-light contrast pair", () => {
    expect(contrastTooltipSurfaceClasses).toContain("bg-content-strong");
    expect(contrastTooltipSurfaceClasses).toContain("text-content-on-light");
  });
});
