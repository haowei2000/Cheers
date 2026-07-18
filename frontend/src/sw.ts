/// <reference lib="webworker" />
// Service worker (built by vite-plugin-pwa injectManifest). Two jobs:
//  1. Precache the app shell so the installed PWA opens instantly. Runtime
//     traffic (/api, /ws, /docs) is deliberately NEVER cached — Cheers is a
//     realtime app; stale API responses are worse than a spinner.
//  2. Web Push: show approval / mention notifications and route clicks back
//     into the app (see src/lib/push.ts for the page side of the bridge).

import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare let self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA fallback: navigations render the precached shell; the gateway paths the
// frontend proxies must pass through untouched.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//, /^\/ws/, /^\/docs/, /^\/health/],
  })
);

/** Payload shape produced by the gateway (server/src/infra/web_push.rs callers). */
interface PushPayload {
  kind?: "permission_request" | "mention";
  channel_id?: string;
  msg_id?: string;
  title?: string;
  body?: string;
  sender_name?: string | null;
}

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload: PushPayload;
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    return;
  }
  event.waitUntil(showPushNotification(payload));
});

async function showPushNotification(payload: PushPayload): Promise<void> {
  // Suppress when a focused window is already viewing this channel — the
  // in-app card/mention is on screen; an OS notification would just nag.
  if (payload.channel_id && (await isChannelFocused(payload.channel_id))) return;

  const title =
    payload.kind === "mention"
      ? payload.sender_name
        ? `${payload.sender_name} mentioned you`
        : "You were mentioned"
      : payload.title || "Approval needed";
  await self.registration.showNotification(title, {
    body: payload.body || "",
    icon: "/pwa-192.png",
    badge: "/pwa-192.png",
    // One notification per message: a re-delivered push replaces, not stacks.
    tag: payload.msg_id || undefined,
    data: payload,
  });
}

/** Ask every open window which channel it has focused (page side answers via
 * the `cheers:query-active-channel` bridge in src/lib/push.ts). A window that
 * doesn't answer within 250 ms counts as "not viewing" — never block a push
 * on a hung tab. */
async function isChannelFocused(channelId: string): Promise<boolean> {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const answers = await Promise.all(
    windows.map(
      (win) =>
        new Promise<string | null>((resolve) => {
          const mc = new MessageChannel();
          const timer = setTimeout(() => resolve(null), 250);
          mc.port1.onmessage = (e) => {
            clearTimeout(timer);
            resolve(typeof e.data === "string" ? e.data : null);
          };
          try {
            win.postMessage({ type: "cheers:query-active-channel" }, [mc.port2]);
          } catch {
            clearTimeout(timer);
            resolve(null);
          }
        })
    )
  );
  return answers.includes(channelId);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const payload = (event.notification.data ?? {}) as PushPayload;
  event.waitUntil(openFromNotification(payload));
});

async function openFromNotification(payload: PushPayload): Promise<void> {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  // Prefer a window already in the chat UI (its ChatLayout can navigate
  // directly); any other window still works — the page bridge redirects onto
  // /chat when ChatLayout isn't mounted (see lib/push.ts openChannelFromPush).
  const win =
    windows.find((w) => new URL(w.url).pathname.startsWith("/chat")) ??
    windows[0];
  if (win) {
    // Reuse the running app: focus it and hand the target over the bridge
    // (src/lib/push.ts navigates + scrolls to the card).
    try {
      await win.focus();
    } catch {
      /* focus can be refused; still deliver the target */
    }
    if (payload.channel_id) {
      win.postMessage({
        type: "cheers:open-channel",
        channelId: payload.channel_id,
        msgId: payload.msg_id ?? null,
      });
    }
    return;
  }
  // Cold start: carry the target in query params; the push bridge consumes
  // them on boot (and strips them from the URL).
  const url = payload.channel_id
    ? `/chat?push_channel=${encodeURIComponent(payload.channel_id)}${
        payload.msg_id ? `&push_msg=${encodeURIComponent(payload.msg_id)}` : ""
      }`
    : "/";
  await self.clients.openWindow(url);
}
