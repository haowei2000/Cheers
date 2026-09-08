import { describe, expect, it } from "vitest";
import {
  canSplitWorkspace,
  parseLocalWorkspacePreference,
  restoreLocalWorkspacePreference,
  resolveWorkspaceLayout,
  toLaneRelativeRect,
  toViewportRect,
  workspacePreferenceKey,
} from "./panelWorkspaceLayout";

describe("workspace allocation", () => {
  it("uses available channel width instead of viewport breakpoints", () => {
    expect(resolveWorkspaceLayout(807, 400)).toEqual({
      sideBySide: false,
      panelWidth: 807,
    });
    expect(resolveWorkspaceLayout(808, 400)).toEqual({
      sideBySide: true,
      panelWidth: 320,
    });
  });
  it("protects the message minimum when resizing a large panel", () => {
    for (const width of [808, 900, 1280, 1920]) {
      const { panelWidth } = resolveWorkspaceLayout(width, 3000);
      expect(width - panelWidth - 8).toBe(480);
    }
  });
  it("protects the panel minimum and honors an available saved width", () => {
    expect(resolveWorkspaceLayout(1200, 100).panelWidth).toBe(320);
    expect(resolveWorkspaceLayout(1200, 460).panelWidth).toBe(460);
    expect(resolveWorkspaceLayout(390, 460)).toEqual({
      sideBySide: false,
      panelWidth: 390,
    });
  });
});

describe("managed floating geometry", () => {
  it("round-trips shared lane geometry through viewport-fixed panel coordinates", () => {
    const lane = { left: 240, top: 96 };
    const shared = { x: 20, y: 30, w: 420, h: 300 };
    expect(toLaneRelativeRect(toViewportRect(shared, lane), lane)).toEqual(shared);
  });
});

describe("local workspace preference", () => {
  it("restores the active panel and clamps the split ratio", () => {
    expect(parseLocalWorkspacePreference({
      width: 420,
      split: true,
      ratio: 0.9,
      active: "files",
    })).toEqual({ width: 420, split: true, ratio: 0.75, active: "files", floats: {} });
  });

  it("ignores an unknown active panel", () => {
    expect(parseLocalWorkspacePreference({
      width: 420,
      split: false,
      ratio: 0.5,
      active: "unknown",
    })).toEqual({ width: 420, split: false, ratio: 0.5, floats: {} });
  });

  it("resets every channel-scoped field when stored JSON is malformed", () => {
    expect(restoreLocalWorkspacePreference("{", "files")).toEqual({
      width: 400,
      split: false,
      ratio: 0.5,
      active: "files",
      floats: {},
      overridden: false,
    });
  });

  it("restores only valid per-channel floating panel geometry", () => {
    expect(parseLocalWorkspacePreference({
      width: 420,
      split: false,
      ratio: 0.5,
      floats: {
        files: { x: 10, y: 20, w: 360, h: 280 },
        workbench: { x: 0, y: 0, w: 0, h: 200 },
        unknown: { x: 0, y: 0, w: 10, h: 10 },
      },
    })?.floats).toEqual({ files: { x: 10, y: 20, w: 360, h: 280 } });
  });

  it("round-trips floating overrides on a channel-specific storage key", () => {
    const saved = JSON.stringify({
      width: 420,
      split: false,
      ratio: 0.5,
      floats: { files: { x: 10, y: 20, w: 360, h: 280 } },
    });
    expect(restoreLocalWorkspacePreference(saved, "viewboard").floats).toEqual({
      files: { x: 10, y: 20, w: 360, h: 280 },
    });
    expect(workspacePreferenceKey("A")).not.toBe(workspacePreferenceKey("B"));
  });

  it("offers split only when the measured panel stage can render it", () => {
    expect(canSplitWorkspace(487, 2)).toBe(false);
    expect(canSplitWorkspace(488, 1)).toBe(false);
    expect(canSplitWorkspace(488, 2)).toBe(true);
  });
});
