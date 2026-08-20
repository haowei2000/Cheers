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
});
