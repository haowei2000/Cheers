// Desktop-shell wrappers for the deep-link + quick-panel + screenshot features
// (B5/B6). Kept out of lib/desktop.ts so the two feature slices stay separable;
// everything here is a no-op / null in the browser, gated on isTauri().

import { invokeDesktop } from "@/lib/desktop";
import { isTauri } from "@/lib/serverConfig";

/** Drain a cheers:// link that arrived before the webview was ready (cold
 * start). The Rust side stashes the launch URL in a PendingDeepLink mutex and
 * ALSO emits a "deep-link" event for warm opens; this command returns the
 * stashed URL exactly once (null when there was none). No-op in the browser. */
export async function takePendingDeepLink(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invokeDesktop<string | null>("take_pending_deep_link");
  } catch {
    return null;
  }
}

/** Bytes produced by the native macOS screen capture, ready to feed into the
 * existing uploadFile() path. Mirror of the Rust CapturedFile: the command
 * returns base64 (NOT a filesystem path) because the WKWebView has no fs plugin
 * to read a path, and adding one would widen the capability surface. */
export interface CapturedFile {
  filename: string;
  content_b64: string;
  mime: string;
}

function capturedToFile(c: CapturedFile): File {
  const bin = atob(c.content_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], c.filename, {
    type: c.mime || "application/octet-stream",
  });
}

/** Native macOS interactive screen capture (`screencapture -i`). Returns a File
 * ready for the channel upload path, or null when the user cancels the crosshair
 * selection. No-op (null) outside the desktop shell.
 *
 * Interactive-only by contract: a hidden call still surfaces the OS crosshair,
 * never a silent grab — do not add a full-screen mode. */
export async function captureScreenshot(): Promise<File | null> {
  if (!isTauri()) return null;
  try {
    const c = await invokeDesktop<CapturedFile>("capture_screenshot");
    return capturedToFile(c);
  } catch (e) {
    // The user dismissing the selection is a normal outcome, not an error.
    if (String(e).toLowerCase().includes("cancel")) return null;
    throw e;
  }
}

/** Subscribe to files handed to the app via Finder "Open With → Cheers" (or
 * `open -a Cheers <file>`). The Rust run-loop reads each file and emits a
 * `cheers://quick-attach` CapturedFile; this delivers it as a ready-to-upload
 * File. Returns an unlisten fn; no-op in the browser. */
export async function onQuickAttach(handler: (file: File) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<CapturedFile>("cheers://quick-attach", (evt) =>
    handler(capturedToFile(evt.payload))
  );
}

/** Drain files that Finder handed the app while no composer was listening (cold
 * start / no channel open), and mark the composer as now listening. The composer
 * calls this on mount; pair with releaseQuickAttach() on unmount. */
export async function takePendingQuickAttach(): Promise<File[]> {
  if (!isTauri()) return [];
  try {
    const list = await invokeDesktop<CapturedFile[]>("take_pending_quick_attach");
    return list.map(capturedToFile);
  } catch {
    return [];
  }
}

/** Tell the Rust side no composer is listening (unmount / no channel), so a
 * Finder open stashes the file instead of emitting into the void. */
export async function releaseQuickAttach(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invokeDesktop("release_quick_attach");
  } catch {
    // best-effort
  }
}
