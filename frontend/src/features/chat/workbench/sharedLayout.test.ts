import { describe, expect, it } from "vitest";
import {
  hasLocalOverride,
  mergeLayout,
  notifyLayoutOverride,
  parseLayout,
  requestLayoutReset,
  subscribeLayoutOverride,
  subscribeLayoutReset,
  toFraction,
  toLaneRect,
} from "./sharedLayout";

const LANE = { width: 1000, height: 800 };

describe("parseLayout", () => {
  it("reads a well-formed layout", () => {
    expect(
      parseLayout({ version: 1, panels: { workbench: { rect: { x: 0, y: 0, w: 0.5, h: 1 }, open: true } } })
    ).toEqual({ version: 1, panels: { workbench: { rect: { x: 0, y: 0, w: 0.5, h: 1 }, open: true } } });
  });

  it("drops a window nobody can render rather than failing the whole read", () => {
    // `.workbench.json` is hand-editable and agent-writable, so one bad entry must not
    // cost the reader every other window's placement.
    const parsed = parseLayout({
      version: 1,
      panels: {
        workbench: { rect: { x: 0, y: 0, w: 0.5, h: 1 } },
        viewboard: { rect: { x: 0, y: 0, w: 0, h: 1 } }, // zero width — not a placement
        nonsense: { rect: { x: 0, y: 0, w: 1, h: 1 } }, // not a window this client has
      },
    });
    expect(Object.keys(parsed!.panels)).toEqual(["workbench"]);
  });

  it("clamps a rect an agent wrote outside the lane", () => {
    const parsed = parseLayout({ version: 1, panels: { files: { rect: { x: 0.8, y: 0.5, w: 5, h: 5 } } } });
    expect(parsed!.panels.files!.rect).toEqual({ x: 0.8, y: 0.5, w: 0.2, h: 0.5 });
  });

  it("refuses a version it does not know", () => {
    expect(parseLayout({ version: 2, panels: {} })).toBeUndefined();
    expect(parseLayout(undefined)).toBeUndefined();
  });

  it("keeps an open flag with no geometry", () => {
    // "open this board" is a complete instruction on its own; the window falls back to
    // its spawn placement.
    expect(parseLayout({ version: 1, panels: { viewboard: { open: true } } })!.panels.viewboard).toEqual({
      open: true,
    });
  });
});

describe("lane fractions", () => {
  it("round-trips a rect through one lane size", () => {
    const rect = { x: 250, y: 100, w: 500, h: 400 };
    expect(toLaneRect(toFraction(rect, LANE)!, LANE)).toEqual(rect);
  });

  it("resolves the same share of a smaller lane", () => {
    // The point of storing fractions: a half-lane window is half of WHATEVER lane the
    // reader has, not 500 stale pixels.
    const half = toFraction({ x: 0, y: 0, w: 500, h: 800 }, LANE)!;
    expect(toLaneRect(half, { width: 600, height: 400 })).toEqual({ x: 0, y: 0, w: 300, h: 400 });
  });

  it("has no fraction to report for a lane with no area", () => {
    expect(toFraction({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("mergeLayout", () => {
  it("keeps another save that touched a different window", () => {
    // Last write wins PER WINDOW. Replacing the whole file would drop the other save.
    const merged = mergeLayout(
      { version: 1, panels: { files: { open: true }, workbench: { open: false } } },
      { version: 1, panels: { workbench: { rect: { x: 0, y: 0, w: 1, h: 1 } } } }
    );
    expect(merged.panels.files).toEqual({ open: true });
    expect(merged.panels.workbench).toEqual({ rect: { x: 0, y: 0, w: 1, h: 1 } });
  });
});

describe("local overrides", () => {
  it("tells the reset control whether it would do anything", () => {
    // The store is what "Reset to channel layout" is enabled by, and what a window
    // listens to in order to rejoin. Both halves fire from one call.
    const seen: string[] = [];
    const stopReset = subscribeLayoutReset(() => seen.push("reset"));
    const stopOverride = subscribeLayoutOverride(() => seen.push("override"));
    notifyLayoutOverride();
    requestLayoutReset();
    stopReset();
    stopOverride();
    // A drag notifies only the override listeners; a reset also tells the windows.
    expect(seen).toEqual(["override", "reset", "override"]);
    // Unsubscribed listeners stay quiet.
    requestLayoutReset();
    expect(seen).toHaveLength(3);
  });

  it("reports no override when storage is unavailable", () => {
    // Private mode and the test runner both throw on localStorage; a window that
    // cannot read its own geometry is simply following the channel.
    expect(hasLocalOverride()).toBe(false);
  });
});

describe("workspace layout sharing", () => {
  it("round-trips dock preferences alongside window visibility", () => {
    const workspace = { width: .4, split: true, ratio: .6, active: "files" as const };
    expect(parseLayout({ version: 1, panels: { files: { open: true } }, workspace })?.workspace).toEqual(workspace);
  });
  it("drops malformed preferences without losing panel declarations", () => {
    const parsed = parseLayout({ version: 1, panels: { files: { open: true } }, workspace: { width: "wide", ratio: .5, split: true } });
    expect(parsed?.workspace).toBeUndefined();
    expect(parsed?.panels.files?.open).toBe(true);
  });
  it("keeps zero fractions instead of mistaking them for absent values", () => {
    expect(parseLayout({
      version: 1,
      panels: {},
      workspace: { width: 0, ratio: 0, split: true },
    })?.workspace).toEqual({ width: 0, ratio: 0, split: true });
  });
  it("preserves workspace preferences when an older writer only updates panels", () => {
    const workspace = { width: .4, split: false, ratio: .5 };
    expect(mergeLayout({ version: 1, panels: {}, workspace }, { version: 1, panels: { files: { open: true } } }).workspace).toEqual(workspace);
  });
  it("preserves shared geometry when a managed panel only updates visibility", () => {
    const rect = { x: .1, y: .2, w: .4, h: .5 };
    const merged = mergeLayout(
      { version: 1, panels: { files: { rect, open: false } } },
      { version: 1, panels: { files: { open: true } } },
    );
    expect(merged.panels.files).toEqual({ rect, open: true });
  });
});
