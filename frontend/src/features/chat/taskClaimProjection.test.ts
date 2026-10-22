import { expect, it, vi } from "vitest";
import type { Message } from "@/types";
import { clearClientSessionData } from "@/lib/clientSession";
import { patchMessageContentData, mergeMessages } from "./messageCollection";
import { getChannelCache, patchCachedMessageContentData, seedFromCache, setChannelCache } from "./chatCache";
import { handleChannelFrame } from "./hooks/useChatRealtime";
import { mergeDiscussionMessages } from "./discussionThread";
import { claimConfirmationUpdate, needsClaimReconciliation } from "./taskClaimProjection";
import { reconcileClaimConfirmations } from "./reconcileClaimConfirmations";
import type { listMessages } from "@/api/messages";

const data = (status = "pending", revision = 1) => ({ claim_id: "claim", requester_id: "user", claim_status: status, claim_revision: revision, resolved: status !== "pending" });
const message = (id = "confirmation", seq = 10, status = "pending", revision = 1): Message => ({ msg_id: id, channel_seq: seq, msg_type: "task_claim_confirmation", sender_id: "bot", sender_type: "bot", content: "Claim confirmation", content_data: data(status, revision) });
const update = (status: string, revision: number) => ({ claim_id: "claim", channel_id: "channel", status, execution_msg_id: null, confirmation_message: { msg_id: "confirmation", content_data: data(status, revision) } });
const response = (messages: Message[]) => ({ messages, data: messages, meta: { has_more: false, has_more_after: false, has_more_before: false, limit: 1 } });

it("converges separate windows and LRU after reordered events, late HTTP and stale history", () => {
  let first = [message()];
  let second = [message()];
  setChannelCache("claim-window", { messages: first });
  const callbacks = (apply: (id: string, value: Message["content_data"]) => void) => ({ onMessage: vi.fn(), onStreamDelta: vi.fn(), onStreamDone: vi.fn(), onMessageDeleted: vi.fn(), onContentDataUpdated: apply });
  const firstCallbacks = callbacks((id, value) => { first = patchMessageContentData(first, id, value); patchCachedMessageContentData("claim-window", id, value); });
  const secondCallbacks = callbacks((id, value) => { second = patchMessageContentData(second, id, value); });
  const event = (status: string, revision: number) => ({ type: "task_claim_updated", channel_id: "channel", data: update(status, revision) });
  handleChannelFrame(event("executing", 2), firstCallbacks);
  handleChannelFrame(event("cancelled", 3), firstCallbacks);
  handleChannelFrame(event("cancelled", 3), secondCallbacks);
  handleChannelFrame(event("executing", 2), secondCallbacks);
  const lateHttp = claimConfirmationUpdate(update("executing", 2), "channel")!;
  first = patchMessageContentData(first, lateHttp.msg_id, lateHttp.content_data);
  first = mergeMessages(first, [message()]);
  // A stale effect write must not undo the event already written to the warm cache.
  setChannelCache("claim-window", { messages: [message()] });
  expect(first[0].content_data).toEqual(data("cancelled", 3));
  expect(second[0].content_data).toEqual(first[0].content_data);
  expect(seedFromCache("claim-window")?.messages[0].content_data).toEqual(first[0].content_data);
});

it("rejects malformed/misrouted event projections and protects claim identity in generic merges", () => {
  const patch = vi.fn();
  const cbs = { onMessage: vi.fn(), onStreamDelta: vi.fn(), onStreamDone: vi.fn(), onMessageDeleted: vi.fn(), onContentDataUpdated: patch };
  for (const bad of [
    { ...update("executing", 2), channel_id: "other" },
    { ...update("executing", 2), claim_id: "other" },
    { ...update("cancelled", 2), status: "executing" },
    update("executing", 0),
    update("executing", 1.5),
  ]) handleChannelFrame({ type: "task_claim_updated", channel_id: "channel", data: bad }, cbs);
  expect(patch).not.toHaveBeenCalled();
  const original = [message("confirmation", 10, "completed", 4)];
  for (const incoming of [{ claim_id: "other", claim_revision: 99, resolved: false }, { claim_revision: 99, resolved: false }, null]) {
    expect(patchMessageContentData(original, "confirmation", incoming)[0].content_data).toEqual(original[0].content_data);
  }
  const legacy = [{ ...message(), content_data: { claim_id: "claim", resolved: true, decision: "accept" } }];
  expect(mergeMessages(legacy, [{ ...message(), content_data: { claim_id: "claim", resolved: false } }])[0].content_data).toMatchObject({ resolved: true, decision: "accept" });
});

it("preserves newer discussion REST metadata when an older live copy overlays it", () => {
  const root: Message = { msg_id: "root", sender_id: "user", sender_type: "user", content: "Discussion", channel_seq: 1 };
  const latest = { ...message("confirmation", 10, "completed", 4), thread_root_msg_id: "root" };
  expect(mergeDiscussionMessages(root, [latest], [message("confirmation", 10, "executing", 2)])[1].content_data).toEqual(latest.content_data);
});

it("refreshes only mutable loaded claims, caps reads at three and preserves explicit deletion", async () => {
  const pending = Array.from({ length: 7 }, (_, index) => message(`m${index}`, index + 1));
  const releases: Array<() => void> = [];
  let active = 0;
  let maximum = 0;
  const read = vi.fn<typeof listMessages>((_channel, opts) => new Promise((resolve) => {
    active++; maximum = Math.max(maximum, active);
    releases.push(() => { active--; const row = pending[opts!.since_seq!]; resolve(response([{ ...row, is_deleted: row.msg_id === "m0", content_data: data("completed", 3) }])); });
  }));
  const apply = vi.fn();
  const work = reconcileClaimConfirmations("channel", [...pending, message("done", 20, "completed", 4)], () => true, apply, read);
  expect(read).toHaveBeenCalledTimes(3);
  for (let pass = 0; pass < 10 && apply.mock.calls.length < 7; pass++) { releases.splice(0).forEach((release) => release()); await Promise.resolve(); await Promise.resolve(); }
  await work;
  expect(maximum).toBe(3);
  expect(apply.mock.calls[0][0].is_deleted).toBe(true);
  expect(mergeMessages([apply.mock.calls[0][0]], [pending[0]])[0].is_deleted).toBe(true);
  expect(needsClaimReconciliation({ ...message(), content_data: { claim_id: "claim", resolved: true, decision: "accept" } })).toBe(true);
});

it("does not infer deletion from filtered history, empty responses or denied membership", async () => {
  const read = vi.fn<typeof listMessages>().mockResolvedValueOnce(response([message("different")])).mockResolvedValueOnce(response([])).mockRejectedValueOnce(new Error("Forbidden"));
  const apply = vi.fn();
  await reconcileClaimConfirmations("channel", [message("one", 1), message("two", 2), message("three", 3)], () => true, apply, read);
  expect(apply).not.toHaveBeenCalled();
});

it("does not retain another account's cached claim state", () => {
  setChannelCache("account-scope", { messages: [message()] });
  clearClientSessionData();
  expect(getChannelCache("account-scope")).toBeNull();
});
