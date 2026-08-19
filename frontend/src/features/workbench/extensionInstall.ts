import type { ExtensionPermissions, ParsedExtension } from "@/features/chat/workbench/extensions/package";

/** `temporary` is a load rather than an install: the package is activated for
 * this session and never persisted. It still goes through the consent dialog,
 * because it is the only scope that may carry renderer code and permissions. */
export type InstallScope = "global" | "personal" | "temporary";
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
