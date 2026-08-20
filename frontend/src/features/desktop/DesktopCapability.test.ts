import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop window capability", () => {
  it("authorizes the local desktop command surface", () => {
    const capabilityPath = resolve(
      process.cwd(),
      "../apps/macos/src-tauri/capabilities/default.json",
    );
    const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as {
      permissions: Array<string | object>;
    };

    expect(capability.permissions).toContain("core:window:allow-start-dragging");
    expect(capability.permissions).toContain("allow-desktop-commands");
  });

  it("limits remote OAuth browser handoff to the official website", () => {
    const capabilityPath = resolve(
      process.cwd(),
      "../apps/macos/src-tauri/capabilities/oauth-remote.json",
    );
    const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as {
      remote: { urls: string[] };
      permissions: string[];
    };

    expect(capability.remote.urls).toEqual([
      "https://tocheers.com/*",
      "https://www.tocheers.com/*",
    ]);
    expect(capability.permissions).toEqual(["allow-desktop-open-oauth-url"]);
  });

  it("opens desktop windows from the React app shell instead of the public website", () => {
    const configPaths = [
      "../apps/macos/src-tauri/tauri.conf.json",
      "../apps/macos/src-tauri/tauri.macos.conf.json",
    ];

    for (const configPath of configPaths) {
      const config = JSON.parse(readFileSync(resolve(process.cwd(), configPath), "utf8")) as {
        app: { windows: Array<{ label: string; url?: string }> };
      };
      const windows = new Map(config.app.windows.map((window) => [window.label, window.url]));

      expect(windows.get("main")).toBe("app.html?desktop=1");
      expect(windows.get("quickpanel")).toBe("app.html?quickpanel=1");
    }
  });
});
