// Desktop-shell (Tauri) wrappers for the approval-context + tray-liveness
// commands. No-ops in the browser (guarded on isTauri()); the underlying Rust
// commands are app-defined and only registered in the desktop shell.

import { invokeDesktop } from "./desktop";
import { isTauri } from "./serverConfig";

/** Read-only metadata about a permission target path, returned by the Rust
 *  `permission_context` command (fs::metadata + `git -C`). Never carries file
 *  contents — only size/is_dir plus repo branch + dirty flag. */
export interface PermissionContext {
  exists: boolean;
  is_dir: boolean;
  size: number | null;
  repo_root: string | null;
  branch: string | null;
  dirty: boolean;
}

/** Stat a permission request's target path locally so the native banner can
 *  show branch/dirty/size context. Returns null in the browser or on error —
 *  the notification still fires without the extra context. */
export async function permissionContext(
  path: string
): Promise<PermissionContext | null> {
  if (!isTauri()) return null;
  try {
    return await invokeDesktop<PermissionContext>("permission_context", { path });
  } catch (e) {
    console.warn("permission_context failed", e);
    return null;
  }
}

/** One agent in the tray roster. `busy` = has an in-flight session. */
export interface TrayAgent {
  name: string;
  busy: boolean;
}

/** Push liveness down to the macOS tray + dock badge (rebuilds the tray menu
 *  roster and sets the dock badge to unread+pending; 0 clears it). Matches the
 *  α1 `tray_update_liveness(unread, pending, agents)` contract. Fire-and-forget:
 *  failures are logged, never thrown. */
export async function trayUpdateLiveness(
  unread: number,
  pending: number,
  agents: TrayAgent[]
): Promise<void> {
  if (!isTauri()) return;
  try {
    await invokeDesktop("tray_update_liveness", { unread, pending, agents });
  } catch (e) {
    console.warn("tray_update_liveness failed", e);
  }
}
