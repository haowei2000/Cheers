import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelProfile } from "@/api/channelProfiles";
import { clearClientSessionData } from "@/lib/clientSession";
import { createChannelProfileStore } from "./channelProfileStore";

const profile = (head: string): ChannelProfile => ({ profile: "code", config: {}, status: { head_commit: head } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const stores: ReturnType<typeof createChannelProfileStore>[] = [];
function setup(load = vi.fn< (channelId: string) => Promise<ChannelProfile | null> >().mockResolvedValue(profile("current"))) {
  const store = createChannelProfileStore(load);
  stores.push(store);
  return { store, load };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared channel profile polling", () => {
  it("serves four consumers from one initial request, one snapshot and one poll timer", async () => {
    const { store, load } = setup();
    const resource = store.resource("channel");
    const notifications = Array.from({ length: 4 }, () => vi.fn());
    const detach = notifications.map((notify, index) => resource.subscribe(notify, true, index === 3 ? 0 : undefined));
    // Hook effects repeat their subscription cursor without invalidating it.
    resource.invalidate(0);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(store.resource("channel").snapshot()).toBe(resource.snapshot());
    notifications.forEach((notify) => expect(notify).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(2);
    detach.slice(0, 3).forEach((unsubscribe) => unsubscribe());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(3);
    detach[3]();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("disabled consumers observe shared snapshots without starting or retaining polling", async () => {
    const { store, load } = setup();
    const resource = store.resource("channel");
    const disabled = vi.fn();
    const detachDisabled = resource.subscribe(disabled, false, 10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const detachEnabled = resource.subscribe(vi.fn(), true, 10);
    await settle();
    expect(load).toHaveBeenCalledOnce();
    expect(disabled).toHaveBeenCalledOnce();
    detachEnabled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledOnce();
    expect(resource.snapshot()).toEqual(profile("current"));
    detachDisabled();
  });

  it("does not overlap slow polls and coalesces changed refresh keys into one fresh read", async () => {
    const old = deferred<ChannelProfile | null>(), fresh = deferred<ChannelProfile | null>();
    const load = vi.fn<(channelId: string) => Promise<ChannelProfile | null>>()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { store } = setup(load);
    const resource = store.resource("channel");
    resource.subscribe(vi.fn(), true, 0);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(load).toHaveBeenCalledTimes(1);
    resource.invalidate(1);
    resource.invalidate(1);
    resource.invalidate(2);
    resource.invalidate(undefined); // a header has no event cursor
    old.resolve(profile("obsolete"));
    await settle();
    expect(resource.snapshot()).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    fresh.resolve(profile("fresh"));
    await settle();
    expect(resource.snapshot()).toEqual(profile("fresh"));
    resource.invalidate(2);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refreshes a settled shared snapshot immediately when an event cursor changes", async () => {
    const { store, load } = setup();
    const resource = store.resource("channel");
    resource.subscribe(vi.fn(), true, 0);
    await settle();
    load.mockResolvedValueOnce(profile("after-event"));
    resource.invalidate(1);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(resource.snapshot()).toEqual(profile("after-event"));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps different channels and their pending responses separate", async () => {
    const a = deferred<ChannelProfile | null>(), b = deferred<ChannelProfile | null>();
    const { store, load } = setup(vi.fn((channelId: string) => channelId === "A" ? a.promise : b.promise));
    const first = store.resource("A"), second = store.resource("B");
    first.subscribe(vi.fn(), true);
    second.subscribe(vi.fn(), true);
    await settle();
    b.resolve(profile("B"));
    await settle();
    expect(first.snapshot()).toBeNull();
    expect(second.snapshot()).toEqual(profile("B"));
    a.resolve(profile("A"));
    await settle();
    expect(first.snapshot()).toEqual(profile("A"));
    expect(second.snapshot()).toEqual(profile("B"));
    expect(load.mock.calls).toEqual([["A"], ["B"]]);
  });

  it("revalidates on remount and ignores the response authored for the previous mount", async () => {
    const old = deferred<ChannelProfile | null>(), fresh = deferred<ChannelProfile | null>();
    const load = vi.fn<(channelId: string) => Promise<ChannelProfile | null>>()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { store } = setup(load);
    const resource = store.resource("channel");
    const detach = resource.subscribe(vi.fn(), true);
    await settle();
    detach();
    expect(vi.getTimerCount()).toBe(0);
    resource.subscribe(vi.fn(), true);
    await settle();
    expect(load).toHaveBeenCalledOnce();
    old.resolve(profile("previous-mount"));
    await settle();
    expect(resource.snapshot()).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    fresh.resolve(profile("remounted"));
    await settle();
    expect(resource.snapshot()).toEqual(profile("remounted"));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("immediately clears snapshots and timers at logout and rejects an old session's delayed result", async () => {
    const old = deferred<ChannelProfile | null>();
    const load = vi.fn<(channelId: string) => Promise<ChannelProfile | null>>()
      .mockResolvedValueOnce(profile("private"))
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(profile("new-session"));
    const { store } = setup(load);
    const resource = store.resource("channel");
    const notify = vi.fn();
    resource.subscribe(notify, true);
    await settle();
    expect(resource.snapshot()).toEqual(profile("private"));
    await vi.advanceTimersByTimeAsync(5_000);
    clearClientSessionData();
    expect(resource.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const current = store.resource("channel");
    current.subscribe(vi.fn(), true);
    await settle();
    old.resolve(profile("old-account"));
    await settle();
    expect(current.snapshot()).toEqual(profile("new-session"));
    expect(resource.snapshot()).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(2); // the private result, then clearing
  });

  it("starts only one request after StrictMode's setup, cleanup and setup cycle", async () => {
    const { store, load } = setup();
    const resource = store.resource("channel");
    resource.subscribe(vi.fn(), true, 0)();
    resource.subscribe(vi.fn(), true, 0);
    await settle();
    expect(load).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("retries after a failed poll and keeps an empty channel disabled", async () => {
    const load = vi.fn<(channelId: string) => Promise<ChannelProfile | null>>()
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(profile("recovered"));
    const { store } = setup(load);
    store.resource("").subscribe(vi.fn(), true);
    expect(vi.getTimerCount()).toBe(0);
    const resource = store.resource("channel");
    resource.subscribe(vi.fn(), true);
    await settle();
    expect(resource.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resource.snapshot()).toEqual(profile("recovered"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops a queued refresh when the last enabled consumer leaves", async () => {
    const old = deferred<ChannelProfile | null>();
    const { store, load } = setup(vi.fn<(channelId: string) => Promise<ChannelProfile | null>>().mockReturnValue(old.promise));
    const resource = store.resource("channel");
    const detach = resource.subscribe(vi.fn(), true, 0);
    await settle();
    resource.invalidate(1);
    detach();
    old.resolve(profile("detached"));
    await settle();
    expect(resource.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(load).toHaveBeenCalledOnce();
  });

  it("retains active channels beyond the inactive cache limit, then evicts unused snapshots", async () => {
    const { store, load } = setup();
    const detach = Array.from({ length: 31 }, (_, index) => store.resource(`channel-${index}`).subscribe(vi.fn(), true));
    await settle();
    expect(load).toHaveBeenCalledTimes(31);
    expect(vi.getTimerCount()).toBe(31);
    expect(store.resource("channel-30").snapshot()).toEqual(profile("current"));
    detach.forEach((unsubscribe) => unsubscribe());
    expect(vi.getTimerCount()).toBe(0);
    expect(store.resource("channel-0").snapshot()).toBeNull();
  });
});
