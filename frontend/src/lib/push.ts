// Page side of the Web Push integration. Three concerns, one module:
//
//  1. Subscription lifecycle — enable/disable/getStatus for the Settings
//     toggle (VAPID key from the gateway, PushManager.subscribe, registry
//     API in src/api/push.ts).
//  2. SW ⇄ page bridge — answers the service worker's "which channel is
//     focused?" query (notification suppression) and receives "open this
//     channel" on notification click.
//  3. Deep-link target — parks the {channelId, msgId} from a clicked
//     notification until the right ChannelView is mounted, which consumes it
//     via consumePushFocusMsg + onPushTarget and jumps to the card.
//
// The service-worker side lives in src/sw.ts; the two communicate only through
// the `cheers:*` postMessage types used below.

import { getChannel } from "@/api/channels";
import { getPersonalWorkspace } from "@/api/workspaces";
import {
  deletePushSubscription,
  getVapidPublicKey,
  registerPushSubscription,
} from "@/api/push";
import { useChatStore } from "@/stores/chatStore";

// ── Active-channel tracking (notification suppression) ─────────────────────

let activeChannelId: string | null = null;

/** ChannelView reports the channel it renders (null on unmount) so the SW can
 * skip OS notifications the user is already looking at. */
export function setActivePushChannel(id: string | null): void {
  activeChannelId = id;
}

/** The channel currently rendered, if any — the desktop notification path
 * applies the same "don't nag about what's on screen" suppression as the SW. */
export function getActivePushChannel(): string | null {
  return activeChannelId;
}

// ── ChatLayout presence (deep links need its store→URL mirroring) ──────────

let chatLayoutMounted = 0;

/** ChatLayout announces itself: selecting a channel through the store only
 * navigates while it is mounted. Returns the un-mark cleanup. */
export function markChatLayoutMounted(): () => void {
  chatLayoutMounted++;
  return () => {
    chatLayoutMounted--;
  };
}

// ── Deep-link target from a clicked notification ────────────────────────────

let pendingFocus: { channelId: string; msgId: string } | null = null;
const targetListeners = new Set<() => void>();

/** Subscribe to "a push target arrived" (fires after the store selection is
 * updated). Returns the unsubscribe function. */
export function onPushTarget(listener: () => void): () => void {
  targetListeners.add(listener);
  return () => targetListeners.delete(listener);
}

/** If a clicked notification targeted `channelId`, hand its msg_id over
 * (once) so the caller can jump to the card. */
export function consumePushFocusMsg(channelId: string): string | null {
  if (!pendingFocus || pendingFocus.channelId !== channelId) return null;
  const { msgId } = pendingFocus;
  pendingFocus = null;
  return msgId;
}

/** Open the channel a notification pointed at: resolve its workspace, select
 * it in the store (ChatLayout mirrors the selection to the URL), and notify
 * listeners (mobile pushes the conversation screen; ChannelView scrolls).
 *
 * `allowRedirect`: when the click lands on a page without ChatLayout mounted
 * (Settings, Friends, /login), the store selection can't navigate — reload
 * onto /chat with the target in query params instead (the cold-start path
 * consumes them). Only the SW-message path may redirect; the cold-start path
 * itself must not, or an unauthenticated boot would redirect in a loop. */
function openChannelFromPush(
  channelId: string,
  msgId: string | null,
  allowRedirect: boolean
): void {
  if (allowRedirect && chatLayoutMounted === 0) {
    const params = new URLSearchParams({ push_channel: channelId });
    if (msgId) params.set("push_msg", msgId);
    window.location.assign(`/chat?${params.toString()}`);
    return;
  }
  if (msgId) pendingFocus = { channelId, msgId };
  getChannel(channelId)
    .then(async (ch) => {
      const store = useChatStore.getState();
      // DMs are anchored to the *initiator's* personal workspace server-side
      // (FK anchor only); the UI convention files every DM under the viewer's
      // own personal workspace — selecting the anchor would strand the click
      // in a foreign workspace the viewer can't render.
      let workspaceId: string | null | undefined = ch.workspace_id;
      if (ch.type === "dm") {
        workspaceId =
          store.personalWorkspace?.workspace_id ??
          (await getPersonalWorkspace().catch(() => null))?.workspace_id ??
          ch.workspace_id;
      }
      if (!workspaceId) return;
      store.hydrateSelection(workspaceId, channelId);
      targetListeners.forEach((l) => l());
      window.dispatchEvent(new CustomEvent("cheers:push-open-chat"));
    })
    .catch(() => {
      // Not a member anymore / stale notification — drop the target quietly.
      pendingFocus = null;
    });
}

/** Route a cheers:// desktop deep link to its channel, reusing the push open
 *  path (ChatLayout mirrors the store selection to the URL). allowRedirect=true
 *  matches the SW click path so a link landing on a non-ChatLayout route still
 *  reaches /chat. */
export function openDeepLinkChannel(channelId: string, msgId: string | null): void {
  openChannelFromPush(channelId, msgId, true);
}

// ── SW message bridge ───────────────────────────────────────────────────────

let bridgeInitialized = false;

/** Install the SW message listener and consume a cold-start deep link
 * (?push_channel=…&push_msg=… placed by the SW's openWindow). Called from
 * App (mounted on every route, so a click reaching a Settings/Friends window
 * still lands); runs once per page load. */
export function initPushBridge(): void {
  if (bridgeInitialized || !("serviceWorker" in navigator)) return;
  bridgeInitialized = true;

  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as
      | { type?: string; channelId?: string; msgId?: string | null }
      | null;
    if (!data?.type) return;
    if (data.type === "cheers:query-active-channel") {
      // Reply over the provided MessageChannel port: the focused channel id,
      // or null when this window isn't focused (SW treats null as "not viewing").
      event.ports[0]?.postMessage(document.hasFocus() ? activeChannelId : null);
    } else if (data.type === "cheers:open-channel" && data.channelId) {
      openChannelFromPush(data.channelId, data.msgId ?? null, true);
    }
  });

  const params = new URLSearchParams(window.location.search);
  const channelId = params.get("push_channel");
  if (channelId) {
    const msgId = params.get("push_msg");
    params.delete("push_channel");
    params.delete("push_msg");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + (qs ? `?${qs}` : "")
    );
    openChannelFromPush(channelId, msgId, false);
  }
}

// ── Subscription lifecycle (Settings toggle) ────────────────────────────────

export type PushStatus =
  /** This browser can't do Web Push (or the SW isn't active — e.g. Vite dev). */
  | "unsupported"
  /** The deployment has no VAPID key — hide the toggle. */
  | "unconfigured"
  /** The user has blocked notifications for this origin in the browser. */
  | "denied"
  | "enabled"
  | "disabled";

function pushCapable(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** applicationServerKey wants raw bytes; the gateway serves base64url. */
function urlB64ToUint8Array(b64: string): Uint8Array {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** The registration with an ACTIVE worker, or undefined. On a first-ever
 * visit the SW is still installing (precaching the shell), and subscribe()
 * rejects on a registration with no active worker — wait for `.ready`, but
 * race a timeout because `.ready` never settles when no SW is registered at
 * all (Vite dev, or registration failed). */
async function getActiveRegistration(
  timeoutMs: number
): Promise<ServiceWorkerRegistration | undefined> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg?.active) return reg;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!pushCapable()) return "unsupported";
  const key = await getVapidPublicKey().catch(() => null);
  if (!key) return "unconfigured";
  if (Notification.permission === "denied") return "denied";
  const reg = await getActiveRegistration(3000);
  if (!reg) return "unsupported";
  const sub = await reg.pushManager.getSubscription();
  return sub ? "enabled" : "disabled";
}

/** Ask for notification permission, subscribe, and register with the gateway.
 * Returns the resulting status (permission prompts can be declined). */
export async function enablePush(): Promise<PushStatus> {
  if (!pushCapable()) return "unsupported";
  const key = await getVapidPublicKey().catch(() => null);
  if (!key) return "unconfigured";
  const reg = await getActiveRegistration(10_000);
  if (!reg) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(key),
  });
  const json = sub.toJSON();
  if (!json.keys?.p256dh || !json.keys?.auth) {
    await sub.unsubscribe().catch(() => {});
    throw new Error("Browser returned a subscription without client keys");
  }
  try {
    await registerPushSubscription({
      endpoint: sub.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent,
    });
  } catch (e) {
    // The gateway never learned about this subscription — a browser-side
    // orphan would read as "enabled" on the next visit while nothing arrives.
    await sub.unsubscribe().catch(() => {});
    throw e;
  }
  return "enabled";
}

/** Unsubscribe locally and drop the gateway row. Safe to call when already
 * disabled. Used by the Settings toggle and on sign-out (a signed-out browser
 * must not keep receiving lock-screen notifications). */
export async function disablePush(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  // Server row first (needs the auth token, so this must run before logout
  // clears it), then the browser-side subscription.
  await deletePushSubscription(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
