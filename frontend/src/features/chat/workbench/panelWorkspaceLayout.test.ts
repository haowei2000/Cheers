import { describe, expect, it } from "vitest";
import {
  parseLocalWorkspacePreference,
  resolveWorkspaceLayout,
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

describe("local workspace preference", () => {
  it("restores the active panel and clamps the split ratio", () => {
    expect(parseLocalWorkspacePreference({
      width: 420,
      split: true,
      ratio: 0.9,
      active: "files",
    })).toEqual({ width: 420, split: true, ratio: 0.75, active: "files" });
  });

  it("ignores an unknown active panel", () => {
    expect(parseLocalWorkspacePreference({
      width: 420,
      split: false,
      ratio: 0.5,
      active: "unknown",
    })).toEqual({ width: 420, split: false, ratio: 0.5 });
  });
});
