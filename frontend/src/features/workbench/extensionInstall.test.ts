import { describe, expect, it } from "vitest";
import { EXTENSION_CHANNEL_RESOURCES, type ExtensionPermissions, type ParsedExtension } from "@/features/chat/workbench/extensions/package";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareSemver, expandedPermissions, installDisposition, permissionGrants, permissionSummary } from "./extensionInstall";

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

  it("handles complex multi-level permissions comparison", () => {
    expect(
      expandedPermissions(
        { "file.write": true, "channel.resources": ["channel.info", "channel.files"] },
        { "file.write": true, "channel.resources": ["channel.info"] },
      ),
    ).toEqual(["channel.resources:channel.files"]);

    expect(
      expandedPermissions(
        { "navigation.open": true, "composer.prefill": true, "automation.manage": true },
        { "navigation.open": true },
      ),
    ).toEqual(["composer.prefill", "automation.manage"]);
  });
});


describe("what a permission actually reaches", () => {
  const everything: ExtensionPermissions = {
    "file.write": true,
    "channel.resources": ["channel.info", "channel.members"],
    "navigation.open": true,
    "composer.prefill": true,
    "automation.manage": true,
    network: "unrestricted",
  };

  it("says which permissions have no resource counterpart", () => {
    expect(permissionGrants(everything).map((grant) => [grant.permission, grant.reach])).toEqual([
      ["file.write", "resource"],
      ["channel.resources", "resource"],
      ["navigation.open", "client"],
      ["composer.prefill", "client"],
      ["automation.manage", "rest"],
      ["network", "client"],
    ]);
  });

  it("grants nothing for a declarative package", () => {
    expect(permissionGrants(undefined)).toEqual([]);
    expect(permissionGrants({})).toEqual([]);
  });

  it("names only resources the gateway still dispatches", () => {
    // The claim `permissionGrants` makes is only true while the gateway routes these
    // names, so read the dispatcher rather than a copy of its list. `resource/mod.rs` is
    // in the frontend CI lane (`.github/ci-paths.json`) so that renaming a resource there
    // fails here.
    const dispatcher = readFileSync(
      fileURLToPath(new URL("../../../../server/src/resource/mod.rs", import.meta.url)),
      "utf8",
    );
    const routed = new Set([...dispatcher.matchAll(/"([a-z][a-z0-9_]*(?:\.[a-z0-9_-]+)+)"\s*(?:=>|\|)/g)].map((match) => match[1]));
    expect(routed.size).toBeGreaterThan(20);
    const named = permissionGrants({ ...everything, "channel.resources": [...EXTENSION_CHANNEL_RESOURCES] })
      .flatMap((grant) => grant.resources);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((resource) => !routed.has(resource))).toEqual([]);
  });

  it("is the one list the consent screen reads", () => {
    expect(permissionSummary({ schemaVersion: 1, id: "notes", version: "1.0.0", title: "Notes", contributes: {}, permissions: everything })).toEqual([
      "Write file",
      "Read channel (2)",
      "Open navigation",
      "Prefill composer",
      "Manage scheduled tasks",
      "Unrestricted network",
    ]);
  });
});
