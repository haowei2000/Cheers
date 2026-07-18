// Desktop deep-link routing (B5). The macOS shell registers the `cheers://`
// scheme; a click anywhere in the OS launches or surfaces the app and hands the
// URL to the webview two ways:
//
//   • cold start — the link fires in Rust `setup()` before any JS listener
//     exists, so it's stashed in a PendingDeepLink mutex and drained here once
//     via `take_pending_deep_link`;
//   • warm — the running app receives a "deep-link" Tauri event.
//
// Both paths funnel through push.ts's channel-open routing so ChatLayout's
// existing store→URL mirroring (and the `cheers:push-open-chat` handler) needs
// no change. No-op in the browser.

import { openDeepLinkChannel } from "@/lib/push";
import { isTauri } from "@/lib/serverConfig";
import { takePendingDeepLink } from "@/lib/desktopQuick";

/** Parse `cheers://channel/<id>?msg=<mid>` → {channelId, msgId}. Tolerant of a
 * trailing slash and a missing msg; returns null for anything else. */
export function parseDeepLink(
  url: string
): { channelId: string; msgId: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "cheers:") return null;
  // cheers://channel/<id> → host="channel", pathname="/<id>". Guard the host so
  // a future cheers://<other> route can't be misread as a channel.
  if (parsed.host !== "channel") return null;
  const channelId = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!channelId) return null;
  return { channelId, msgId: parsed.searchParams.get("msg") };
}

function route(url: string): void {
  const target = parseDeepLink(url);
  if (target) openDeepLinkChannel(target.channelId, target.msgId);
}

/** Wire deep-link delivery for the main window. Returns a cleanup that removes
 * the warm-open listener. Safe to call unconditionally — no-op in the browser
 * and in the quick-panel window (App.tsx gates it behind !isQuickPanel; routing
 * in a ChatLayout-less window would hijack it). */
export function initDeepLinks(): () => void {
  if (!isTauri()) return () => {};

  // Cold start: a link that launched the app is waiting in the Rust mutex.
  void takePendingDeepLink().then((url) => {
    if (url) route(url);
  });

  // Warm: the running app gets the URL as an event. `listen` is dynamically
  // imported (Tauri-only, keeps it out of the web bundle) and async; track a
  // cancel flag so an unmount before it resolves still tears the listener down.
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<string>("deep-link", (event) => {
        if (event.payload) route(event.payload);
      })
    )
    .then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
