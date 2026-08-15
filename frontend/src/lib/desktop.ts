// Desktop-shell (Tauri) integration. Everything here is a no-op in the
// browser: the Tauri plugin modules are imported dynamically behind an
// isTauri() guard, so the web bundle neither ships nor executes them.

import { isTauri } from "@/lib/serverConfig";

let permissionChecked = false;

/** Call an app-defined Tauri command. Only valid inside the desktop shell —
 * callers gate on isTauri() (the Connector settings section is Tauri-only). */
export async function invokeDesktop<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Native folder picker (macOS open panel, directory mode). Returns the chosen
 * absolute path, or null if cancelled / not in the desktop shell. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}

/** A personal package installed on this Mac under ~/.cheers/extensions. The server
 * never sees its bytes; the frontend validates them before exposing renderer assets. */
export interface PersonalExtension {
  id: string;
  contentBase64: string;
  sha256: string;
}

export interface DownloadedExtension {
  contentBase64: string;
  sha256: string;
  source: string;
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Fetch inert package bytes through the native official-catalog downloader. */
export async function downloadCatalogExtension(source: string, sha256: string): Promise<Uint8Array> {
  if (!isTauri()) throw new Error("Official one-click installation requires Cheers for Mac");
  const extension = await invokeDesktop<DownloadedExtension>("extension_catalog_download", { source, sha256 });
  if (extension.sha256 !== sha256 || extension.source !== source) throw new Error("Downloaded extension metadata mismatch");
  return bytesFromBase64(extension.contentBase64);
}

/** Personal extensions installed on this machine. Empty in the browser. */
export async function listPersonalExtensions(): Promise<PersonalExtension[]> {
  if (!isTauri()) return [];
  return invokeDesktop<PersonalExtension[]>("extensions_list");
}

/** Atomically install or update a validated personal extension package. */
export async function installPersonalExtension(id: string, bytes: Uint8Array, sha256: string): Promise<void> {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  await invokeDesktop("extensions_install", { id, contentBase64: btoa(binary), sha256 });
  window.dispatchEvent(new Event("cheers:extensions-changed"));
}

/** Uninstall a personal extension by id. Idempotent. */
export async function removePersonalExtension(id: string): Promise<void> {
  await invokeDesktop("extensions_remove", { id });
  window.dispatchEvent(new Event("cheers:extensions-changed"));
}

/** Pick and read a development package without installing it. */
export async function pickDevelopmentExtension(): Promise<(PersonalExtension & { path: string }) | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "Cheers extension", extensions: ["cheers-extension"] }],
  });
  if (typeof path !== "string") return null;
  const extension = await invokeDesktop<PersonalExtension>("extension_dev_read", { path });
  return { ...extension, path };
}

export function readDevelopmentExtension(path: string): Promise<PersonalExtension> {
  return invokeDesktop<PersonalExtension>("extension_dev_read", { path });
}

/** Launch-at-login (login item). Wraps @tauri-apps/plugin-autostart. */
export async function getAutostart(): Promise<boolean> {
  if (!isTauri()) return false;
  const autostart = await import("@tauri-apps/plugin-autostart");
  return autostart.isEnabled();
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  const autostart = await import("@tauri-apps/plugin-autostart");
  if (enabled) await autostart.enable();
  else await autostart.disable();
}

/** A newer desktop build published on the release feed. */
export interface AppUpdate {
  version: string;
  notes?: string;
}

/** Check the signed latest.json feed for a newer desktop build. Returns null
 * when up to date (or outside the shell). The updater verifies the release
 * signature against the pubkey compiled into the app, so a tampered feed can
 * withhold updates but never push code. */
export async function checkAppUpdate(): Promise<AppUpdate | null> {
  if (!isTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return { version: update.version, notes: update.body };
}

/** Download + install the pending update, then relaunch. Re-checks rather than
 * holding the handle from checkAppUpdate: the user may sit on the prompt for a
 * while, and a stale handle would install a build that is no longer latest.
 *
 * Throws if the re-check finds nothing — the caller only gets here after the
 * user acted on a shown update, so "nothing to install" means the feed moved
 * (or the network dropped) and the caller must surface that. Returning quietly
 * would leave the button spinning forever, since the success path never
 * returns: relaunch() replaces the process. */
export async function installAppUpdate(): Promise<never | void> {
  if (!isTauri()) return;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) throw new Error("The update is no longer available — try again.");
  await update.downloadAndInstall();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Show a macOS native notification. WKWebView has no Push API, so the
 * desktop shell listens on the user-scoped WS (ChatLayout) and raises these
 * instead of Web Push. Fire-and-forget; failures are logged, never thrown. */
export async function notifyNative(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const notification = await import("@tauri-apps/plugin-notification");
    if (!permissionChecked) {
      permissionChecked = true;
      if (!(await notification.isPermissionGranted())) {
        await notification.requestPermission();
      }
    }
    notification.sendNotification({ title, body });
  } catch (e) {
    console.warn("native notification failed", e);
  }
}
