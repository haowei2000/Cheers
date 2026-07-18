// Runtime gateway-address resolution. In the browser the frontend is served
// same-origin with the gateway (nginx proxies /api and /ws), so every URL is
// relative and nothing here changes behavior: getServerBase() returns null and
// each resolver falls back to the existing build-time/import.meta.env logic.
//
// In the desktop shell (Tauri) the app runs on tauri://localhost and must be
// pointed at a gateway explicitly: the first-run ServerPicker stores a base
// origin here, and every REST/WS/asset URL is derived from it. One storage
// key, read synchronously, no async config loading.

const STORAGE_KEY = "cheers.server_base";

/** Running inside the Tauri desktop shell? */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The configured gateway origin (e.g. "https://www.tocheers.com"), or null
 * when unset — null means "same-origin", the browser deployment. */
export function getServerBase(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeBase(raw);
  } catch {
    return null;
  }
}

/** Persist the gateway origin. Pass null to clear (back to same-origin). */
export function setServerBase(url: string | null): void {
  try {
    if (url === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, normalizeBase(url) ?? "");
  } catch {
    /* storage unavailable — picker will re-prompt */
  }
}

/** Normalize user input to a bare origin: adds https:// when no scheme,
 * strips path/trailing slash. Returns null for garbage. */
export function normalizeBase(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/** REST base, e.g. "https://host/api/v1" or the same-origin "/api/v1". */
export function apiBase(): string {
  const base = getServerBase();
  if (base) return `${base}/api/v1`;
  return (
    (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ||
    "/api/v1"
  );
}

/** WS base, e.g. "wss://host". Falls back to the build-time override, then
 * same-origin — the browser behavior this module must not change. */
export function wsBase(): string {
  const base = getServerBase();
  if (base) return base.replace(/^http/i, "ws");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return (
    (import.meta as { env?: Record<string, string> }).env?.VITE_WS_BASE_URL ||
    `${proto}//${location.host}`
  );
}

/** Absolutize a server-relative path (avatar URLs etc.) against the
 * configured gateway; leaves absolute URLs and same-origin mode untouched. */
export function resolveServerUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  const base = getServerBase();
  return base ? `${base}${path.startsWith("/") ? "" : "/"}${path}` : path;
}

/** The origin users should see in shareable links / copy-paste commands: the
 * gateway origin when configured (a tauri:// origin is useless to share). */
export function serverOrigin(): string {
  return getServerBase() ?? window.location.origin;
}
