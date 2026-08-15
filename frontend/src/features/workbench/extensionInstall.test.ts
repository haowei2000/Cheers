import { describe, expect, it } from "vitest";
import type { ParsedExtension } from "@/features/chat/workbench/extensions/package";
import { compareSemver, expandedPermissions, installDisposition } from "./extensionInstall";

function extension(version: string, sha256: string): ParsedExtension {
  return {
    manifest: { schemaVersion: 1, id: "notes", version, title: "Notes", contributes: {}, permissions: {} },
    scenes: [], rendererExtension: null, bytes: new Uint8Array(), sha256,
  };
}

describe("extension installation decisions", () => {
  it("distinguishes install, update, replacement, and identical bytes", () => {
    expect(installDisposition(extension("1.0.0", "a"))).toBe("install");
    expect(installDisposition(extension("1.0.0", "a"), { version: "1.0.0", sha256: "a", permissions: {} })).toBe("already");
    expect(installDisposition(extension("1.1.0", "b"), { version: "1.0.0", sha256: "a", permissions: {} })).toBe("update");
    expect(installDisposition(extension("1.0.0", "b"), { version: "1.0.0", sha256: "a", permissions: {} })).toBe("replace");
    expect(installDisposition(extension("0.9.0", "b"), { version: "1.0.0", sha256: "a", permissions: {} })).toBe("replace");
  });

  it("reports permission expansion separately from existing grants", () => {
    expect(expandedPermissions(
      { "file.write": true, "channel.resources": ["channel.info", "channel.members"], network: "unrestricted" },
      { "file.write": true, "channel.resources": ["channel.info"] },
    )).toEqual(["channel.resources:channel.members", "network:unrestricted"]);
  });

  it("orders SemVer prerelease identifiers numerically and ignores build metadata", () => {
    expect(compareSemver("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-beta", "1.0.0-beta.1")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0+catalog.2", "1.0.0+catalog.1")).toBe(0);
  });
});
