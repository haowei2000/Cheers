import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/authStore";
import { buildWsUrl } from "@/api/client";
import { createHookHarness } from "@/test/hookHarness";
import { useChatRealtime } from "@/features/chat/hooks/useChatRealtime";
import { useUserSocket } from "@/features/chat/hooks/useUserSocket";
import { useFleetLive } from "@/features/fleet/useFleetLive";
import { clearClientSessionData, clientSessionGeneration } from "./clientSession";
import * as realtime from "./realtimeTransport";
import { RealtimeTransport } from "./realtimeTransport";

vi.mock("@/api/client", () => ({ buildWsUrl: vi.fn((path: string) => `ws://gateway${path}`) }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), ...await import("@/test/hookHarness") }));
vi.mock("@/stores/authStore", async (original) => {
  const module = await original<typeof import("@/stores/authStore")>();
  const store = module.useAuthStore;
  // The controlled harness renders manually. Read hook snapshots from the real
  // store while retaining its actual actions, subscription and refresh logic.
  const snapshot = <T>(selector: (state: ReturnType<typeof store.getState>) => T) => selector(store.getState());
  return { ...module, useAuthStore: Object.assign(snapshot, store) };
});

function accessToken(sid = "login-1", serial = 1, sub = "user", iss = "cheers") {
  const encoded = btoa(JSON.stringify({ sub, sid, iss, iat: serial })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${encoded}.signature`;
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  frame(frame: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.readyState = FakeSocket.CLOSED; }
  disconnect(code = 1006) { this.close(); this.onclose?.({ code }); }
  ofType(type: string) { return this.sent.filter((frame) => frame.type === type); }
}

let transport: RealtimeTransport;
let windowEvents: EventTarget;
let documentEvents: EventTarget;
const realRestoreSession = useAuthStore.getState().restoreSession;
async function dial() {
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  socket.frame({ type: "auth_ok", user_id: "user" });
  return socket;
}
function channel(socket: FakeSocket, id: string, type = "message") {
  socket.frame({ type, scope: "channel", channel_id: id, data: { msg_id: id } });
}

describe("shared authenticated realtime transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    windowEvents = new EventTarget();
    documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", windowEvents);
    vi.stubGlobal("document", documentEvents);
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.mocked(buildWsUrl).mockImplementation((path) => `ws://gateway${path}`);
    // Zustand copies actions into new state objects. Restoring a spy on the
    // previous object alone cannot restore the action in the current state.
    useAuthStore.setState({ user: null, token: "token-1", sessionExpired: false, restoreSession: realRestoreSession });
    transport = new RealtimeTransport();
  });
  afterEach(() => {
    transport.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shares one connection and one wire subscription across user, chat and Fleet leases", async () => {
    const user = vi.fn();
    const chat = vi.fn();
    const fleet = vi.fn();
    const ready = vi.fn();
    transport.subscribeUser({ onFrame: user });
    const leaveChat = transport.subscribeChannels(["A"], { onFrame: chat, onReady: ready });
    const leaveFleet = transport.subscribeChannels(["A", "B"], { onFrame: fleet });
    const socket = await dial();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.ofType("auth")).toEqual([{ type: "auth", token: "token-1" }]);
    expect(socket.ofType("subscribe").map((f) => f.channel_id)).toEqual(["A", "B"]);
    socket.frame({ type: "subscribed", channel_id: "B" });
    expect(ready).not.toHaveBeenCalled();
    socket.frame({ type: "subscribed", channel_id: "A" });
    expect(ready).toHaveBeenCalledTimes(1);
    channel(socket, "B");
    expect(chat).not.toHaveBeenCalled();
    expect(fleet).toHaveBeenCalledTimes(1);
    socket.frame({ type: "notification", scope: "user", data: { id: 1 } });
    expect(user).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
    socket.frame({ type: "message", data: {} }); // unscoped frames never leak into chat
    expect(chat).not.toHaveBeenCalled();
    leaveChat();
    expect(socket.ofType("unsubscribe")).toHaveLength(0);
    channel(socket, "A");
    expect(fleet).toHaveBeenCalledTimes(2);
    leaveFleet();
    expect(socket.ofType("unsubscribe").map((f) => f.channel_id)).toEqual(["A", "B"]);
    expect(socket.readyState).toBe(FakeSocket.OPEN); // user lease retains connection
  });

  it("cancels a StrictMode probe before dialing, and reuses a warm socket during channel switches", async () => {
    const leave = transport.subscribeChannels(["A"], { onFrame: vi.fn() });
    leave();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(0);
    const leaveA = transport.subscribeChannels(["A"], { onFrame: vi.fn() });
    const socket = await dial();
    leaveA();
    transport.subscribeChannels(["B"], { onFrame: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.ofType("subscribe").map((f) => f.channel_id)).toEqual(["A", "B"]);
  });

  it("reconciles user events on auth and channel events only after each resubscribe ack", async () => {
    const userReady = vi.fn();
    const chatReady = vi.fn();
    const statuses = vi.fn();
    transport.subscribeUser({ onFrame: vi.fn(), onReady: userReady });
    transport.subscribeChannels(["A"], { onFrame: vi.fn(), onReady: chatReady, onStatus: statuses });
    const first = await dial();
    expect(userReady).toHaveBeenCalledTimes(1);
    expect(chatReady).not.toHaveBeenCalled();
    first.frame({ type: "subscribed", channel_id: "A" });
    first.disconnect(4408);
    expect(statuses).toHaveBeenLastCalledWith("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    const second = await dial();
    expect(userReady).toHaveBeenCalledTimes(2);
    expect(chatReady).toHaveBeenCalledTimes(1);
    second.frame({ type: "subscribed", channel_id: "A" });
    expect(chatReady).toHaveBeenCalledTimes(2);
    expect(statuses).toHaveBeenLastCalledWith("online");
  });

  it("exhausts backoff and recovers from online/visibility without requiring an open chat", async () => {
    const status = vi.fn();
    transport.subscribeUser({ onFrame: vi.fn(), onStatus: status });
    await vi.advanceTimersByTimeAsync(0);
    for (let count = 0; count <= 10; count++) {
      FakeSocket.instances.at(-1)!.disconnect();
      if (count < 10) await vi.advanceTimersByTimeAsync(Math.min(1000 * 2 ** count, 30_000));
    }
    expect(status).toHaveBeenLastCalledWith("offline");
    windowEvents.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(12);
  });

  it("allows background resource RPC without any mounted view and preserves real nested error codes", async () => {
    const request = transport.request("fs.write", { channel_id: "A", path: "file", content: "draft", base_version: 1 });
    const rejected = expect(request).rejects.toMatchObject({ code: "VERSION_CONFLICT", message: "version changed" });
    const socket = await dial();
    await Promise.resolve();
    expect(socket.ofType("subscribe")).toHaveLength(0);
    const sent = socket.ofType("resource_req")[0];
    expect(sent.resource).toBe("fs.write");
    socket.frame({ type: "resource_res", req_id: sent.req_id, ok: false, error: { code: "VERSION_CONFLICT", message: "version changed" } });
    await rejected;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
  });

  it("correlates out-of-order resource responses and keeps a pending request leased after a view detaches", async () => {
    const leave = transport.subscribeChannels(["A"], { onFrame: vi.fn() });
    const socket = await dial();
    const first = transport.request("fs.read", { path: "one" });
    const second = transport.request("fs.read", { path: "two" });
    leave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    const [a, b] = socket.ofType("resource_req");
    socket.frame({ type: "resource_res", req_id: b.req_id, ok: true, data: "second" });
    socket.frame({ type: "resource_res", req_id: a.req_id, ok: true, data: "first" });
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
  });

  it("rejects disconnected writes and never replays them after reconnect", async () => {
    transport.subscribeUser({ onFrame: vi.fn() });
    const first = await dial();
    const request = transport.request("fs.write", { path: "file", content: "draft" });
    const rejected = expect(request).rejects.toMatchObject({ code: "DISCONNECTED" });
    first.disconnect();
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    const second = await dial();
    expect(second.ofType("resource_req")).toHaveLength(0);
  });

  it("removes timed-out readiness waiters so delayed auth cannot send expired writes", async () => {
    const request = transport.request("fs.write", { path: "file" });
    const rejected = expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.frame({ type: "auth_ok" });
    await Promise.resolve();
    expect(socket.ofType("resource_req")).toHaveLength(0);
  });

  it("drops stale socket frames and requests immediately on logout, before React effects run", async () => {
    const receive = vi.fn();
    transport.subscribeUser({ onFrame: receive });
    const first = await dial();
    const staleHandler = first.onmessage!;
    const pending = transport.request("fs.write", {});
    const rejected = expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });
    clearClientSessionData();
    useAuthStore.setState({ token: null });
    await rejected;
    staleHandler({ data: JSON.stringify({ type: "notification", scope: "user", data: {} }) });
    expect(receive).not.toHaveBeenCalled();
    await expect(transport.request("fs.write", {})).rejects.toMatchObject({ code: "DISCONNECTED" });
    useAuthStore.setState({ token: "new-account" });
    const nextReceive = vi.fn();
    transport.subscribeUser({ onFrame: nextReceive });
    const second = await dial();
    second.frame({ type: "notification", scope: "user", data: {} });
    expect(nextReceive).toHaveBeenCalledTimes(1);
    expect(receive).not.toHaveBeenCalled();
  });

  it("refreshes auth once, reconnects with the new token, and ignores an old socket's close", async () => {
    let finish!: (token: string | null) => void;
    const restore = vi.spyOn(useAuthStore.getState(), "restoreSession").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    transport.subscribeUser({ onFrame: vi.fn() });
    const first = await dial();
    const oldClose = first.onclose!;
    first.frame({ type: "auth_err" });
    oldClose({ code: 4401 });
    expect(restore).toHaveBeenCalledTimes(1);
    useAuthStore.setState({ token: "fresh-token" });
    finish("fresh-token");
    await Promise.resolve();
    await Promise.resolve();
    const second = await dial();
    expect(second.ofType("auth")).toEqual([{ type: "auth", token: "fresh-token" }]);
    expect(useAuthStore.getState().sessionExpired).toBe(false);
  });

  it("renews proactive refresh in place while chat, user and Fleet hooks retain their leases", async () => {
    const initial = accessToken();
    const refreshed = accessToken("login-1", 2);
    useAuthStore.getState().setAuth({ user_id: "user", display_name: "User" }, initial);
    vi.spyOn(realtime, "realtimeTransport").mockReturnValue(transport);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: refreshed, user_id: "user", role: "member" }), { status: 200 })));
    const user = vi.fn();
    const stream = vi.fn();
    const ready = vi.fn();
    const fleet = vi.fn();
    const harness = createHookHarness();
    const render = () => harness.render(() => {
      useUserSocket(user);
      useChatRealtime("A", { onMessage: vi.fn(), onStreamDelta: stream, onStreamDone: vi.fn(), onMessageDeleted: vi.fn(), onReady: ready });
      useFleetLive(["A"], fleet);
    });
    try {
      render();
      const socket = await dial();
      socket.frame({ type: "subscribed", channel_id: "A" });
      await vi.advanceTimersByTimeAsync(400);
      const generation = clientSessionGeneration();
      const write = transport.request("fs.write", { path: "draft", content: "retained" }).then(
        (data) => ({ fulfilled: true, data }),
        (error: unknown) => ({ fulfilled: false, error }),
      );
      const request = socket.ofType("resource_req")[0];
      channel(socket, "A", "message_stream");

      // This is the same restore operation invoked by App's eight-minute timer.
      expect(await useAuthStore.getState().restoreSession()).toBe(refreshed);
      render();
      expect(clientSessionGeneration()).toBe(generation);
      expect(socket.readyState).toBe(FakeSocket.OPEN);
      expect(socket.ofType("auth")).toEqual([{ type: "auth", token: initial }, { type: "auth", token: refreshed }]);
      socket.frame({ type: "auth_ok", user_id: "user" });
      channel(socket, "A", "message_stream");
      socket.frame({ type: "resource_res", req_id: request.req_id, ok: true, data: { saved: true } });
      await expect(write).resolves.toEqual({ fulfilled: true, data: { saved: true } });
      await vi.advanceTimersByTimeAsync(400);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(socket.ofType("subscribe").map((frame) => frame.channel_id)).toEqual(["A"]);
      expect(socket.ofType("unsubscribe")).toHaveLength(0);
      expect(socket.ofType("presence_focus")).toHaveLength(0);
      expect(socket.ofType("resource_req")).toHaveLength(1);
      expect(stream).toHaveBeenCalledTimes(2);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(user.mock.calls.filter(([kind]) => kind === "connected")).toHaveLength(1);
      expect(fleet).toHaveBeenCalledTimes(1);

      useAuthStore.getState().logout();
      render();
      expect(socket.readyState).toBe(FakeSocket.CLOSED);
      useAuthStore.getState().setAuth({ user_id: "user", display_name: "User" }, accessToken("login-2", 3));
      render();
      const next = await dial();
      next.frame({ type: "subscribed", channel_id: "A" });
      channel(next, "A", "message_stream");
      expect(FakeSocket.instances).toHaveLength(2);
      expect(ready).toHaveBeenCalledTimes(2);
      expect(stream).toHaveBeenCalledTimes(3);
    } finally { harness.unmount(); }
  });

  it.each([
    ["another login", accessToken("login-2", 2)],
    ["another user", accessToken("login-1", 2, "other-user")],
    ["another issuer", accessToken("login-1", 2, "user", "other-gateway")],
    ["an opaque credential", "opaque-token"],
  ])("reconnects instead of renewing %s on the old connection", async (_label, token) => {
    useAuthStore.getState().setAuth({ user_id: "user", display_name: "User" }, accessToken());
    transport.subscribeChannels(["A"], { onFrame: vi.fn() });
    const socket = await dial();
    socket.frame({ type: "subscribed", channel_id: "A" });
    useAuthStore.getState().setToken(token);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(socket.ofType("auth")).toHaveLength(1);
    const next = await dial();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(next.ofType("auth")).toEqual([{ type: "auth", token }]);
    expect(next.ofType("subscribe").map((frame) => frame.channel_id)).toEqual(["A"]);
  });

  it("does not renew an old endpoint after the configured gateway changes", async () => {
    useAuthStore.getState().setAuth({ user_id: "user", display_name: "User" }, accessToken());
    transport.subscribeUser({ onFrame: vi.fn() });
    const socket = await dial();
    vi.mocked(buildWsUrl).mockReturnValue("wss://other-gateway/ws");
    useAuthStore.getState().setToken(accessToken("login-1", 2));
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(socket.ofType("auth")).toHaveLength(1);
  });

  it.each(["auth_err", "expired close"])("still closes and expires a rejected renewed login on %s", async (rejection) => {
    useAuthStore.getState().setAuth({ user_id: "user", display_name: "User" }, accessToken());
    const restore = vi.spyOn(useAuthStore.getState(), "restoreSession").mockResolvedValue(null);
    transport.subscribeUser({ onFrame: vi.fn() });
    const socket = await dial();
    const write = transport.request("fs.write", { path: "draft" });
    const rejected = expect(write).rejects.toMatchObject({ code: "DISCONNECTED" });
    useAuthStore.getState().setToken(accessToken("login-1", 2));
    if (rejection === "auth_err") socket.frame({ type: "auth_err" });
    else socket.disconnect(4401);
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionExpired).toBe(true);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    windowEvents.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("cannot expire or reconnect a new account when an old refresh finishes", async () => {
    let finish!: (token: string | null) => void;
    vi.spyOn(useAuthStore.getState(), "restoreSession").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    transport.subscribeUser({ onFrame: vi.fn() });
    const first = await dial();
    first.disconnect(4401);
    useAuthStore.getState().logout();
    useAuthStore.setState({ token: "new-account", sessionExpired: false });
    finish(null);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(useAuthStore.getState().sessionExpired).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("isolates denied channel subscriptions from authorized channels and user notifications", async () => {
    const status = vi.fn();
    const receive = vi.fn();
    transport.subscribeUser({ onFrame: receive });
    transport.subscribeChannels(["A"], { onFrame: receive });
    transport.subscribeChannels(["denied"], { onFrame: vi.fn(), onStatus: status });
    const socket = await dial();
    socket.frame({ type: "subscription_error", channel_id: "denied", code: "PERMISSION_DENIED", reason: "not a channel member" });
    expect(status).toHaveBeenLastCalledWith("offline");
    channel(socket, "A");
    socket.frame({ type: "notification", scope: "user", data: {} });
    expect(receive).toHaveBeenCalledTimes(2);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
  });

  it("waits for a new ack and repeats catch-up when retrying a previously authorized channel", async () => {
    const status = vi.fn();
    const ready = vi.fn();
    transport.subscribeChannels(["A"], { onFrame: vi.fn(), onStatus: status, onReady: ready });
    const socket = await dial();
    socket.frame({ type: "subscribed", channel_id: "A" });
    expect(ready).toHaveBeenCalledTimes(1);
    socket.frame({ type: "subscription_error", channel_id: "A", code: "PERMISSION_DENIED", reason: "revoked" });
    expect(status).toHaveBeenLastCalledWith("offline");
    transport.reconnectNow();
    expect(socket.ofType("subscribe")).toHaveLength(2);
    expect(status).toHaveBeenLastCalledWith("connecting");
    expect(ready).toHaveBeenCalledTimes(1);
    socket.frame({ type: "subscribed", channel_id: "A" });
    expect(status).toHaveBeenLastCalledWith("online");
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("reconnects immediately with an explicit new token while an obsolete refresh is still pending", async () => {
    let finish!: (token: string | null) => void;
    vi.spyOn(useAuthStore.getState(), "restoreSession").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    transport.subscribeUser({ onFrame: vi.fn() });
    const first = await dial();
    first.disconnect(4401);
    useAuthStore.getState().setToken("password-change-token");
    const second = await dial();
    expect(second.ofType("auth")).toEqual([{ type: "auth", token: "password-change-token" }]);
    finish(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(useAuthStore.getState().sessionExpired).toBe(false);
    expect(second.readyState).toBe(FakeSocket.OPEN);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("closes and rejects pending RPC when REST marks the session expired", async () => {
    transport.subscribeUser({ onFrame: vi.fn() });
    const first = await dial();
    const request = transport.request("fs.write", {});
    const rejected = expect(request).rejects.toMatchObject({ code: "DISCONNECTED" });
    useAuthStore.getState().markSessionExpired();
    await rejected;
    expect(first.readyState).toBe(FakeSocket.CLOSED);
    await expect(transport.request("fs.write", {})).rejects.toMatchObject({ code: "DISCONNECTED" });
    windowEvents.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
    useAuthStore.getState().setToken("signed-in-again");
    const second = await dial();
    expect(second.ofType("auth")[0].token).toBe("signed-in-again");
  });
});
