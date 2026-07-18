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

/** A personal workbench plugin installed on this Mac (~/.cheers/plugins/<id>.html).
 * `content` is the full bundle, used inline as the sandbox iframe srcDoc — the
 * server never sees it. Mirror of the Rust `PersonalPlugin` (plugins.rs). */
export interface PersonalPlugin {
  id: string;
  content: string;
}

/** Personal plugins installed on this machine. Empty in the browser. */
export async function listPersonalPlugins(): Promise<PersonalPlugin[]> {
  if (!isTauri()) return [];
  return invokeDesktop<PersonalPlugin[]>("plugins_list");
}

/** Install (or update, same id overwrites) a personal plugin. The caller has
 * already parsed + validated the manifest and extracted its id. */
export async function installPersonalPlugin(id: string, content: string): Promise<void> {
  await invokeDesktop("plugins_install", { id, content });
}

/** Uninstall a personal plugin by id. Idempotent. */
export async function removePersonalPlugin(id: string): Promise<void> {
  await invokeDesktop("plugins_remove", { id });
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
