import { buildWsUrl } from "@/api/client";
import { useAuthStore } from "@/stores/authStore";
import { clientSessionGeneration } from "./clientSession";
import { ReadinessWaiters } from "./readinessWaiters";

export type RealtimeStatus = "connecting" | "online" | "reconnecting" | "offline";
export interface RealtimeFrame {
  type: string;
  scope?: string;
  channel_id?: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

export class ResourceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ResourceError";
  }
}

interface Observer {
  onFrame: (frame: RealtimeFrame) => void;
  onReady?: () => void;
  onStatus?: (status: RealtimeStatus) => void;
}
interface Subscription extends Observer {
  channels: Set<string> | null;
  ready: boolean;
}
interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: ResourceError) => void;
  timer: ReturnType<typeof setTimeout>;
  cancelReady: () => void;
}

const MAX_RETRIES = 10;
const IDLE_CLOSE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** One authenticated browser connection. Views own leases, never sockets.
 * Channel subscriptions are reference counted; resource requests keep their own
 * lease so background saves do not depend on a mounted chat view. Writes are
 * rejected on disconnect, never replayed across a new connection/session. */
export class RealtimeTransport {
  private socket: WebSocket | null = null;
  private token = useAuthStore.getState().token;
  private generation = clientSessionGeneration();
  private authenticated = false;
  private authFailed = useAuthStore.getState().sessionExpired;
  private blocked = false;
  private refreshing: object | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private status: RealtimeStatus = "connecting";
  private readonly subscribers = new Set<Subscription>();
  private readonly channels = new Map<string, number>();
  private readonly acknowledged = new Set<string>();
  private readonly denied = new Set<string>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly waiters = new ReadinessWaiters();
  private readonly unsubscribeAuth: () => void;

  constructor() {
    this.unsubscribeAuth = useAuthStore.subscribe((state) => {
      if (this.generation !== clientSessionGeneration()) this.clearSession();
      if (state.sessionExpired) {
        this.authFailed = true;
        this.refreshing = null;
        this.closeSocket();
        this.setStatus("offline");
        return;
      }
      if (state.token === this.token && !this.blocked && !this.authFailed) return;
      // A valid explicit token change must not wait for an obsolete refresh
      // request, which may remain unresolved while the network is unavailable.
      this.refreshing = null;
      this.token = state.token;
      this.blocked = !state.token;
      this.authFailed = false;
      this.closeSocket();
      this.retryCount = 0;
      this.setStatus(state.token ? "reconnecting" : "offline");
      if (this.hasDemand()) this.scheduleConnect();
    });
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.revive);
      window.addEventListener("cheers:session-cleared", this.clearSession);
      document.addEventListener("visibilitychange", this.revive);
    }
  }

  subscribeUser(observer: Observer): () => void {
    return this.subscribe(null, observer);
  }

  subscribeChannels(channelIds: string[], observer: Observer): () => void {
    return this.subscribe(new Set(channelIds), observer);
  }

  private subscribe(channels: Set<string> | null, observer: Observer): () => void {
    const sub: Subscription = { ...observer, channels, ready: false };
    this.subscribers.add(sub);
    this.clearIdle();
    for (const id of channels ?? []) {
      const count = this.channels.get(id) ?? 0;
      this.channels.set(id, count + 1);
      if (!count && this.authenticated) this.send({ type: "subscribe", channel_id: id });
    }
    this.updateSubscriber(sub);
    this.scheduleConnect();
    return () => {
      if (!this.subscribers.delete(sub)) return;
      for (const id of channels ?? []) {
        const count = (this.channels.get(id) ?? 1) - 1;
        if (count) this.channels.set(id, count);
        else {
          this.channels.delete(id);
          this.acknowledged.delete(id);
          this.denied.delete(id);
          if (this.authenticated) this.send({ type: "unsubscribe", channel_id: id });
        }
      }
      this.scheduleIdle();
    };
  }

  private hasDemand(): boolean {
    return this.subscribers.size > 0 || this.pending.size > 0;
  }

  private updateSubscriber(sub: Subscription) {
    const denied = sub.channels && [...sub.channels].some((id) => this.denied.has(id));
    const ready = this.authenticated && !denied && (!sub.channels || [...sub.channels].every((id) => this.acknowledged.has(id)));
    sub.onStatus?.(denied ? "offline" : ready ? "online" : this.status === "online" ? "connecting" : this.status);
    if (ready && !sub.ready) {
      sub.ready = true;
      sub.onReady?.();
    }
  }

  private setStatus(status: RealtimeStatus) {
    this.status = status;
    for (const sub of this.subscribers) this.updateSubscriber(sub);
  }

  private clearRetry() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearIdle() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle() {
    if (this.hasDemand()) return;
    this.clearRetry();
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.hasDemand()) this.closeSocket();
    }, IDLE_CLOSE_MS);
  }

  private scheduleConnect() {
    if (this.retryTimer !== null || this.socket || !this.hasDemand() || this.blocked || this.authFailed || this.refreshing || !this.token) return;
    // Deferral also avoids dialing during StrictMode's effect cleanup probe.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 0);
  }

  private connect() {
    if (this.socket || !this.hasDemand() || this.blocked || this.authFailed || this.refreshing || !this.token) return;
    const token = this.token;
    const generation = this.generation;
    let socket: WebSocket;
    try {
      socket = new WebSocket(buildWsUrl("/ws"));
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    const current = () => this.socket === socket && generation === clientSessionGeneration();
    socket.onopen = () => {
      if (current()) socket.send(JSON.stringify({ type: "auth", token }));
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      let frame: RealtimeFrame;
      try {
        const parsed: unknown = JSON.parse(event.data as string);
        if (!parsed || typeof parsed !== "object" || typeof (parsed as RealtimeFrame).type !== "string") return;
        frame = parsed as RealtimeFrame;
      } catch { return; }
      this.handleFrame(frame);
    };
    socket.onclose = (event) => {
      if (!current()) return;
      this.closeSocket();
      if (event.code === 4401) this.refreshAuth();
      else this.retry();
    };
    socket.onerror = () => { if (current()) socket.close(); };
  }

  private retry() {
    if (!this.hasDemand() || this.authFailed || this.blocked || this.refreshing) return;
    if (this.retryCount >= MAX_RETRIES) {
      this.setStatus("offline");
      return;
    }
    this.setStatus("reconnecting");
    const delay = Math.min(1000 * 2 ** this.retryCount++, 30_000);
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  reconnectNow = () => {
    if (this.authFailed || this.blocked || this.refreshing || !this.token) return;
    if (this.authenticated) {
      // Membership can change while the connection stays healthy. Retry only
      // denied channels; authorized channel streams keep flowing throughout.
      for (const id of this.denied) this.send({ type: "subscribe", channel_id: id });
      this.denied.clear();
      this.setStatus("online");
      return;
    }
    if (this.socket?.readyState === WebSocket.CONNECTING) return;
    this.clearRetry();
    this.retryCount = 0;
    this.closeSocket();
    this.setStatus("reconnecting");
    this.scheduleConnect();
  };

  private revive = () => {
    if (document.visibilityState !== "hidden" && this.hasDemand()) this.reconnectNow();
  };

  private refreshAuth() {
    if (this.refreshing) return;
    this.closeSocket();
    this.setStatus("reconnecting");
    const refresh = {};
    const generation = this.generation;
    const rejectedToken = this.token;
    this.refreshing = refresh;
    void useAuthStore.getState().restoreSession().catch(() => null).then((token) => {
      if (this.refreshing !== refresh || generation !== clientSessionGeneration()) return;
      this.refreshing = null;
      const currentToken = useAuthStore.getState().token;
      // A password change/manual sign-in can supersede a pending refresh.
      if (currentToken && currentToken !== rejectedToken && (token === currentToken || this.token === currentToken)) {
        this.token = currentToken;
        this.authFailed = false;
        this.scheduleConnect();
      } else {
        this.authFailed = true;
        this.setStatus("offline");
        useAuthStore.getState().markSessionExpired();
      }
    });
  }

  private handleFrame(frame: RealtimeFrame) {
    if (frame.type === "auth_ok") {
      this.authenticated = true;
      this.retryCount = 0;
      for (const id of this.channels.keys()) this.send({ type: "subscribe", channel_id: id });
      this.setStatus("online");
      this.waiters.release();
      return;
    }
    if (frame.type === "auth_err") { this.refreshAuth(); return; }
    if (frame.type === "subscribed") {
      if (frame.channel_id && this.channels.has(frame.channel_id)) {
        this.acknowledged.add(frame.channel_id);
        this.denied.delete(frame.channel_id);
        for (const sub of this.subscribers) this.updateSubscriber(sub);
      }
      return;
    }
    if (frame.type === "subscription_error") {
      if (frame.channel_id && this.channels.has(frame.channel_id)) {
        this.denied.add(frame.channel_id);
        this.acknowledged.delete(frame.channel_id);
        for (const sub of this.subscribers) {
          if (sub.channels?.has(frame.channel_id)) sub.ready = false;
          this.updateSubscriber(sub);
        }
      }
      return;
    }
    if (frame.type === "resource_res") {
      const id = typeof frame.req_id === "string" ? frame.req_id : "";
      const request = this.pending.get(id);
      if (!request) return;
      if (frame.ok === true) request.resolve(frame.data);
      else {
        const error = frame.error as { code?: string; message?: string } | string | undefined;
        const code = typeof error === "object" && error ? error.code : undefined;
        const message = typeof error === "string" ? error : error?.message;
        request.reject(new ResourceError(code ?? "ERROR", message ?? "resource error"));
      }
      this.finishRequest(id);
      return;
    }
    if (!this.authenticated) return;
    for (const sub of this.subscribers) {
      if (sub.channels === null ? frame.scope === "user" : frame.scope === "channel" && !!frame.channel_id && sub.channels.has(frame.channel_id)) {
        sub.onFrame(frame);
      }
    }
  }

  private send(frame: Record<string, unknown>): boolean {
    if (!this.authenticated || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try { this.socket.send(JSON.stringify(frame)); return true; }
    catch { this.socket.close(); return false; }
  }

  sendPresenceFocus = (channelId: string, focus: { bot_id: string; path?: string | null } | null) => {
    this.send({ type: "presence_focus", channel_id: channelId, focus });
  };

  request(resource: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.generation !== clientSessionGeneration() || this.blocked || this.authFailed || !this.token) {
      return Promise.reject(new ResourceError("DISCONNECTED", "not authenticated"));
    }
    this.clearIdle();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        reject(new ResourceError("TIMEOUT", "resource request timed out"));
        this.finishRequest(id);
      }, REQUEST_TIMEOUT_MS);
      const request: PendingRequest = { resolve, reject, timer, cancelReady: () => {} };
      this.pending.set(id, request);
      const send = () => {
        if (!this.pending.has(id)) return;
        if (!this.send({ type: "resource_req", req_id: id, resource, params })) {
          reject(new ResourceError("DISCONNECTED", "socket not connected"));
          this.finishRequest(id);
        }
      };
      if (this.authenticated) send();
      else {
        const ready = this.waiters.wait();
        request.cancelReady = ready.cancel;
        void ready.promise.then(send, (error: ResourceError) => {
          reject(error);
          this.finishRequest(id);
        });
        this.clearRetry();
        this.retryCount = 0;
        this.scheduleConnect();
      }
    });
  }

  private finishRequest(id: string) {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    request.cancelReady();
    this.pending.delete(id);
    this.scheduleIdle();
  }

  private closeSocket() {
    this.clearRetry();
    this.authenticated = false;
    this.acknowledged.clear();
    this.denied.clear();
    for (const sub of this.subscribers) sub.ready = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    const error = new ResourceError("DISCONNECTED", "socket closed");
    this.waiters.release(error);
    for (const [id, request] of this.pending) {
      request.reject(error);
      this.finishRequest(id);
    }
  }

  private clearSession = () => {
    this.generation = clientSessionGeneration();
    this.blocked = true;
    this.refreshing = null;
    this.closeSocket();
    this.clearIdle();
    this.subscribers.clear();
    this.channels.clear();
    this.setStatus("offline");
  };

  dispose() {
    this.clearSession();
    this.unsubscribeAuth();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.revive);
      window.removeEventListener("cheers:session-cleared", this.clearSession);
      document.removeEventListener("visibilitychange", this.revive);
    }
  }
}

let transport: RealtimeTransport | undefined;
export function realtimeTransport(): RealtimeTransport {
  return transport ??= new RealtimeTransport();
}

export function sendResourceRequest(resource: string, params: Record<string, unknown>): Promise<unknown> {
  return realtimeTransport().request(resource, params);
}
