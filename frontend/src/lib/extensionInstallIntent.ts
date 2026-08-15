const STORAGE_KEY = "cheers.extension_install_intent";
export const EXTENSION_INSTALL_EVENT = "cheers:extension-install-intent";

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OFFICIAL_PREFIX = "https://haowei2000.github.io/Cheers/downloads/extensions/";

export interface ExtensionInstallIntent {
  source: string;
  sha256: string;
  id: string;
  version: string;
}

export function parseExtensionInstallDeepLink(value: string): ExtensionInstallIntent | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "cheers:" || url.host !== "extension" || url.pathname !== "/install") return null;
  const source = url.searchParams.get("source") ?? "";
  const sha256 = url.searchParams.get("sha256") ?? "";
  const id = url.searchParams.get("id") ?? "";
  const version = url.searchParams.get("version") ?? "";
  if (!source.startsWith(OFFICIAL_PREFIX) || !SHA256.test(sha256) || !ID.test(id) || !SEMVER.test(version)) return null;
  try {
    const packageUrl = new URL(source);
    if (packageUrl.origin !== "https://haowei2000.github.io" || packageUrl.search || packageUrl.hash) return null;
    if (!packageUrl.pathname.endsWith(`/${sha256}.cheers-extension`)) return null;
    const path = packageUrl.pathname.slice("/Cheers/downloads/extensions/".length).split("/");
    if (path.length !== 3 || path[0] !== id || path[1] !== version) return null;
  } catch { return null; }
  return { source, sha256, id, version };
}

export function storeExtensionInstallIntent(intent: ExtensionInstallIntent): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(intent)); } catch { /* unavailable */ }
  window.dispatchEvent(new Event(EXTENSION_INSTALL_EVENT));
}

export function peekExtensionInstallIntent(): ExtensionInstallIntent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as ExtensionInstallIntent | null;
    if (!value) return null;
    return parseExtensionInstallDeepLink(
      `cheers://extension/install?${new URLSearchParams({ source: value.source, sha256: value.sha256, id: value.id, version: value.version }).toString()}`,
    );
  } catch { return null; }
}

export function clearExtensionInstallIntent(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* unavailable */ }
}
