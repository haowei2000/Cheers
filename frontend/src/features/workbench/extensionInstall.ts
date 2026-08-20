import type { ExtensionManifest, ExtensionPermissions, ParsedExtension } from "@/features/chat/workbench/extensions/package";

/** `temporary` is a load rather than an install: the package is activated for
 * this session and never persisted. It still goes through the consent dialog,
 * because it is the only scope that may carry renderer code and permissions. */
export type InstallScope = "personal" | "temporary";
export type InstallDisposition = "install" | "update" | "replace" | "already";

export interface ExtensionInstallCandidate {
  extension: ParsedExtension;
  scope: InstallScope;
  source: "file" | "official-catalog";
  sourceLabel: string;
}

export interface InstalledExtensionIdentity {
  version: string;
  sha256: string;
  permissions: ExtensionPermissions;
}

function semverParts(version: string): { core: [number, number, number]; prerelease: string[] | null } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/.exec(version);
  return match
    ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? null }
    : { core: [0, 0, 0], prerelease: null };
}

export function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const aIdentifier = a.prerelease[index];
    const bIdentifier = b.prerelease[index];
    if (aIdentifier === undefined) return -1;
    if (bIdentifier === undefined) return 1;
    if (aIdentifier === bIdentifier) continue;
    const aNumeric = /^\d+$/.test(aIdentifier);
    const bNumeric = /^\d+$/.test(bIdentifier);
    if (aNumeric && bNumeric) return BigInt(aIdentifier) < BigInt(bIdentifier) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aIdentifier < bIdentifier ? -1 : 1;
  }
  return 0;
}

export function installDisposition(
  candidate: ParsedExtension,
  installed?: InstalledExtensionIdentity,
): InstallDisposition {
  if (!installed) return "install";
  if (candidate.sha256 === installed.sha256) return "already";
  return compareSemver(candidate.manifest.version, installed.version) > 0 ? "update" : "replace";
}

export function expandedPermissions(
  next: ExtensionPermissions,
  current?: ExtensionPermissions,
): string[] {
  const previous = current ?? {};
  const expanded: string[] = [];
  for (const permission of ["file.write", "navigation.open", "composer.prefill", "automation.manage"] as const) {
    if (next[permission] && !previous[permission]) expanded.push(permission);
  }
  const previousResources = new Set(previous["channel.resources"] ?? []);
  for (const resource of next["channel.resources"] ?? []) {
    if (!previousResources.has(resource)) expanded.push(`channel.resources:${resource}`);
  }
  if (next.network === "unrestricted" && previous.network !== "unrestricted") expanded.push("network:unrestricted");
  return expanded;
}

/** Where a granted permission actually lands.
 *
 * `resource` is the platform's own authorization vocabulary — the names
 * `server/src/resource/mod.rs` dispatches, which every bot and every agent is also
 * authorized against. `rest` and `client` are the two reaches that have no resource
 * counterpart and never will: one goes to a REST endpoint, the other never leaves the
 * browser. */
export type PermissionReach = "resource" | "rest" | "client";

export interface PermissionGrant {
  /** The manifest key that was granted. */
  permission: string;
  reach: PermissionReach;
  /** Resource-protocol names this permission lets the renderer call. Empty unless
   * `reach` is `"resource"`. */
  resources: string[];
  label: string;
}

/** Answer "what can this extension do?" in the platform's own terms.
 *
 * The manifest vocabulary and the resource vocabulary are not the same list and should
 * not be merged — a manifest permission is a consent unit shown to a person, a resource
 * name is a dispatch key. This is the translation between them, and it is deliberately
 * partial: four of the six permissions have no resource counterpart, and saying so is
 * the point. A mapping that quietly dropped them would make a consent screen read as if
 * `automation.manage` and `network` were nothing.
 *
 * The enforcement points are `SandboxRenderer`'s host-RPC gate and `RendererHost`'s
 * `CHANNEL_READ_WHITELIST`; this describes them, it does not replace them. */
export function permissionGrants(permissions: ExtensionPermissions | undefined): PermissionGrant[] {
  const granted = permissions ?? {};
  const resources = granted["channel.resources"] ?? [];
  const grants: PermissionGrant[] = [];
  if (granted["file.write"]) {
    grants.push({ permission: "file.write", reach: "resource", resources: ["fs.write"], label: "Write file" });
  }
  if (resources.length) {
    grants.push({ permission: "channel.resources", reach: "resource", resources: [...resources], label: `Read channel (${resources.length})` });
  }
  if (granted["navigation.open"]) {
    grants.push({ permission: "navigation.open", reach: "client", resources: [], label: "Open navigation" });
  }
  if (granted["composer.prefill"]) {
    grants.push({ permission: "composer.prefill", reach: "client", resources: [], label: "Prefill composer" });
  }
  if (granted["automation.manage"]) {
    grants.push({ permission: "automation.manage", reach: "rest", resources: [], label: "Manage scheduled tasks" });
  }
  if (granted.network === "unrestricted") {
    grants.push({ permission: "network", reach: "client", resources: [], label: "Unrestricted network" });
  }
  return grants;
}

/** The consent-screen labels, in manifest order. One list, derived from the grants, so
 * a permission cannot be added to the vocabulary and forgotten here. */
export function permissionSummary(manifest: ExtensionManifest): string[] {
  return permissionGrants(manifest.permissions).map((grant) => grant.label);
}
