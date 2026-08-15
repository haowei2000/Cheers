import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop window capability", () => {
  it("authorizes the custom macOS titlebar drag command", () => {
    const capabilityPath = resolve(
      process.cwd(),
      "../apps/macos/src-tauri/capabilities/default.json",
    );
    const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as {
      permissions: Array<string | object>;
    };

    expect(capability.permissions).toContain("core:window:allow-start-dragging");
  });
});
