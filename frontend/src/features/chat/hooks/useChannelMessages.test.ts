import { beforeEach, expect, it, vi } from "vitest";
import { createHookHarness } from "@/test/hookHarness";
import type { Channel, Message } from "@/types";
import { listMessages } from "@/api/messages";
import { clearClientSessionData } from "@/lib/clientSession";
import { getChannelCache, setChannelCache } from "../chatCache";
import { useChannelMessages } from "./useChannelMessages";

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), ...await import("@/test/hookHarness") }));
vi.mock("@/api/messages", () => ({ listMessages: vi.fn() }));
vi.mock("@/api/channels", () => ({ markChannelRead: vi.fn().mockResolvedValue(undefined) }));
const row = (id: string): Message => ({ msg_id: id, sender_id: "bot", sender_type: "bot", content: "Claim confirmation", msg_type: "task_claim_confirmation", channel_seq: 10, content_data: { claim_id: id, claim_status: "pending", claim_revision: 1, resolved: false } });
const response = (messages: Message[]) => ({ messages, data: messages, meta: { has_more_before: false, has_more_after: false, has_more: false, limit: 1 } });
beforeEach(() => vi.clearAllMocks());

it("revalidates warm channel B while A's claim refresh remains pending and ignores late A results", async () => {
  const a = row("claim-A");
  const b = row("claim-B");
  setChannelCache("reconcile-A", { messages: [a] });
  setChannelCache("reconcile-B", { messages: [b] });
  let finishA!: (result: ReturnType<typeof response>) => void;
  vi.mocked(listMessages).mockImplementation((channel, opts) => {
    if (opts?.limit !== 1) return Promise.resolve(response([]));
    if (channel === "reconcile-A") return new Promise((resolve) => { finishA = resolve; });
    return Promise.resolve(response([{ ...b, content_data: { ...b.content_data, resolved: true, claim_status: "completed", claim_revision: 3 } }]));
  });
  const harness = createHookHarness();
  const activeChannelRef = { current: "reconcile-A" as string | null };
  const channelA = { channel_id: "reconcile-A" } as Channel;
  const channelB = { channel_id: "reconcile-B" } as Channel;
  const render = (channel: Channel) => harness.render(() => useChannelMessages({ channel, preview: false, activeChannelRef, patchChannel: vi.fn(), onPermissionResolved: vi.fn() }));
  render(channelA);
  expect(listMessages).toHaveBeenCalledWith("reconcile-A", { since_seq: 9, limit: 1 });
  activeChannelRef.current = "reconcile-B";
  render(channelB);
  render(channelB);
  await vi.waitFor(() => expect(render(channelB).messages[0].content_data).toMatchObject({ claim_status: "completed", claim_revision: 3 }));
  expect(listMessages).toHaveBeenCalledWith("reconcile-B", { since_seq: 9, limit: 1 });
  finishA(response([{ ...a, content_data: { ...a.content_data, resolved: true, claim_status: "cancelled", claim_revision: 4 } }]));
  await Promise.resolve();
  await Promise.resolve();
  expect(render(channelB).messages.map((message) => message.msg_id)).toEqual(["claim-B"]);
  expect(render(channelB).messages[0].content_data).toMatchObject({ claim_status: "completed" });
  harness.unmount();
});

it("ignores an old account's delayed page and finally while the new account loads its own page", async () => {
  const channel = { channel_id: "pagination-account" } as Channel;
  const activeChannelRef = { current: channel.channel_id as string | null };
  const oldCurrent = { ...row("old-current"), msg_type: "normal" as const, content_data: null };
  const newCurrent = { ...oldCurrent, msg_id: "new-current", channel_seq: 20 };
  const oldPage = { ...oldCurrent, msg_id: "old-secret-page", channel_seq: 9 };
  const newPage = { ...newCurrent, msg_id: "new-page", channel_seq: 19 };
  setChannelCache(channel.channel_id, { messages: [oldCurrent], hasMore: true });
  let finishOld!: (result: ReturnType<typeof response>) => void;
  let finishNew!: (result: ReturnType<typeof response>) => void;
  vi.mocked(listMessages).mockImplementation((_channel, opts) => {
    if (opts?.before === "old-current") return new Promise((resolve) => { finishOld = resolve; });
    if (opts?.before === "new-current") return new Promise((resolve) => { finishNew = resolve; });
    if (opts?.limit === 50) return Promise.resolve({ ...response([newCurrent]), meta: { ...response([]).meta, has_more_before: true } });
    return Promise.resolve(response([]));
  });
  const harness = createHookHarness();
  const render = () => harness.render(() => useChannelMessages({ channel, preview: false, activeChannelRef, patchChannel: vi.fn(), onPermissionResolved: vi.fn() }));
  render();
  const oldWork = render().loadMore();
  expect(render().loadingMore).toBe(true);
  clearClientSessionData();
  render().loadHistory();
  await vi.waitFor(() => expect(render().messages[0]?.msg_id).toBe("new-current"));
  expect(render().loadingMore).toBe(false);
  const newWork = render().loadMore();
  expect(render().loadingMore).toBe(true);
  finishOld(response([oldPage]));
  await oldWork;
  expect(render().messages.map((message) => message.msg_id)).toEqual(["new-current"]);
  expect(render().loadingMore).toBe(true);
  expect(getChannelCache(channel.channel_id)?.messages.map((message) => message.msg_id)).toEqual(["new-current"]);
  finishNew(response([newPage]));
  await newWork;
  expect(render().messages.map((message) => message.msg_id)).toEqual(["new-page", "new-current"]);
  expect(render().loadingMore).toBe(false);
  harness.unmount();
});

it("reconciles a newly loaded claim after an already running claim refresh finishes", async () => {
  const channel = { channel_id: "queued-claims" } as Channel;
  const activeChannelRef = { current: channel.channel_id as string | null };
  const a = row("claim-first");
  const b = { ...row("claim-older"), channel_seq: 5 };
  setChannelCache(channel.channel_id, { messages: [a], hasMore: true });
  let finishA!: (result: ReturnType<typeof response>) => void;
  vi.mocked(listMessages).mockImplementation((_channel, opts) => {
    if (opts?.before) return Promise.resolve(response([b]));
    if (opts?.limit === 1 && opts.since_seq === 9) return new Promise((resolve) => { finishA = resolve; });
    if (opts?.limit === 1 && opts.since_seq === 4) return Promise.resolve(response([{ ...b, content_data: { ...b.content_data, resolved: true, claim_status: "cancelled", claim_revision: 3 } }]));
    return Promise.resolve(response([]));
  });
  const harness = createHookHarness();
  const render = () => harness.render(() => useChannelMessages({ channel, preview: false, activeChannelRef, patchChannel: vi.fn(), onPermissionResolved: vi.fn() }));
  render();
  await render().loadMore();
  expect(render().messages.find((message) => message.msg_id === b.msg_id)?.content_data).toMatchObject({ claim_status: "pending" });
  finishA(response([a]));
  await vi.waitFor(() => expect(render().messages.find((message) => message.msg_id === b.msg_id)?.content_data).toMatchObject({ claim_status: "cancelled", claim_revision: 3 }));
  expect(listMessages).toHaveBeenCalledWith(channel.channel_id, { since_seq: 4, limit: 1 });
  harness.unmount();
});
