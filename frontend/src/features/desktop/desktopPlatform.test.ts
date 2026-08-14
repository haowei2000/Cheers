import { describe, expect, it } from "vitest";
import {
  resolveDesktopPlatform,
  resolveWindowChromeVariant,
  usesMacKeyboardShortcuts,
} from "./desktopPlatform";
import {
  createWindowChromePaneGeometry,
  macosNativeControlsInset,
} from "./WindowChromeModel";

describe("desktop window chrome platform model", () => {
  it("keeps browser routes inline", () => {
    expect(resolveDesktopPlatform({ tauri: false, platform: "MacIntel" })).toBe("web");
    expect(resolveWindowChromeVariant("web")).toBe("inline");
  });

  it("maps native shells to platform-specific renderers", () => {
    expect(resolveDesktopPlatform({ tauri: true, platform: "MacIntel" })).toBe("macos");
    expect(resolveDesktopPlatform({ tauri: true, platform: "Win32" })).toBe("windows");
    expect(resolveDesktopPlatform({ tauri: true, platform: "Linux x86_64" })).toBe("linux");
    expect(resolveWindowChromeVariant("macos")).toBe("macos-overlay");
    expect(resolveWindowChromeVariant("windows")).toBe("desktop-commandbar");
    expect(resolveWindowChromeVariant("linux")).toBe("desktop-commandbar");
  });

  it("keeps keyboard conventions independent from the rendering surface", () => {
    expect(usesMacKeyboardShortcuts({ platform: "MacIntel" })).toBe(true);
    expect(usesMacKeyboardShortcuts({ platform: "Win32" })).toBe(false);
  });

  it("models pane geometry independently from native control insets", () => {
    expect(createWindowChromePaneGeometry(true)).toEqual({
      railWidth: 56,
      sidebarWidth: 240,
      sidebarOpen: true,
    });
    expect(createWindowChromePaneGeometry(undefined)).toBeUndefined();
    expect(macosNativeControlsInset(false)).toBe(96);
    expect(macosNativeControlsInset(true)).toBe(0);
  });
});
