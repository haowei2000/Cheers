import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookHarness } from "@/test/hookHarness";
import { resolveTaskClaim, type TaskClaimUpdate } from "@/api/taskClaims";
import { clearClientSessionData } from "@/lib/clientSession";
import type { Message } from "@/types";
import { TaskClaimConfirmationCard, TaskClaimConfirmationFooter } from "./TaskClaimConfirmationCard";
import { patchMessageContentData } from "./messageCollection";

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), ...await import("@/test/hookHarness") }));
vi.mock("@/api/taskClaims", () => ({ resolveTaskClaim: vi.fn() }));
const initial: Message = { msg_id: "confirmation", msg_type: "task_claim_confirmation", sender_id: "bot", sender_type: "bot", content: "Claim confirmation", content_data: { claim_id: "claim", requester_id: "user", claim_revision: 1, claim_status: "pending", resolved: false } };
const update = (status: string, revision: number): TaskClaimUpdate => ({ claim_id: "claim", channel_id: "channel", status, execution_msg_id: null, confirmation_message: { msg_id: "confirmation", content_data: { ...initial.content_data, claim_status: status, claim_revision: revision, resolved: status !== "pending" } } });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

beforeEach(() => vi.clearAllMocks());

describe("claim confirmation lifecycle on one mounted card", () => {
  it("renders changed canonical props for cancel, expiry and completion without remounting", () => {
    const harness = createHookHarness();
    const render = (message: Message) => harness.render(() => TaskClaimConfirmationCard({ message, channelId: "channel", currentUserId: "user" }));
    expect(render(initial).props.actionable).toBe(true);
    for (const [status, note, label] of [["cancelled", null, "Task claim cancelled"], ["failed", "expired", "Task claim expired"], ["completed", null, "Task completed"]]) {
      const card = render({ ...initial, content_data: { ...initial.content_data, resolved: true, claim_status: status, claim_revision: 3, resolution_note: note } });
      expect(card.props.actionable).toBe(false);
      expect(renderToStaticMarkup(<TaskClaimConfirmationFooter {...card.props} />)).toContain(label);
    }
    harness.unmount();
  });

  it("patches the same message collection after HTTP, and late acceptance cannot undo WS cancellation", async () => {
    const request = deferred<TaskClaimUpdate>();
    vi.mocked(resolveTaskClaim).mockReturnValue(request.promise);
    const harness = createHookHarness();
    let messages = [initial];
    const patch = vi.fn((id: string, data: Message["content_data"]) => { messages = patchMessageContentData(messages, id, data); });
    const render = () => harness.render(() => TaskClaimConfirmationCard({ message: messages[0], channelId: "channel", currentUserId: "user", onContentDataUpdated: patch }));
    render().props.onResolve("accept");
    expect(render().props.busy).toBe(true);
    render().props.onResolve("accept");
    expect(resolveTaskClaim).toHaveBeenCalledTimes(1);
    messages = patchMessageContentData(messages, "confirmation", update("cancelled", 3).confirmation_message!.content_data);
    expect(render().props.actionable).toBe(false);
    request.resolve(update("executing", 2));
    await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(messages[0].content_data).toMatchObject({ claim_status: "cancelled", claim_revision: 3 });
    expect(renderToStaticMarkup(<TaskClaimConfirmationFooter {...render().props} />)).toContain("Task claim cancelled");
    harness.unmount();
  });

  it("shows a retryable inline failure and never records resolution locally", async () => {
    vi.mocked(resolveTaskClaim).mockRejectedValue(new Error("Permission changed. Try again."));
    const harness = createHookHarness();
    const patch = vi.fn();
    const render = () => harness.render(() => TaskClaimConfirmationCard({ message: initial, channelId: "channel", currentUserId: "user", onContentDataUpdated: patch }));
    render().props.onResolve("reject");
    await vi.waitFor(() => expect(render().props.error).toContain("Permission changed"));
    expect(render().props.actionable).toBe(true);
    expect(render().props.busy).toBe(false);
    expect(patch).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<TaskClaimConfirmationFooter {...render().props} />)).toContain('role="alert"');
    harness.unmount();
  });

  it.each(["channel", "session", "unmount"])("ignores completion after %s scope ends", async (end) => {
    const request = deferred<TaskClaimUpdate>();
    vi.mocked(resolveTaskClaim).mockReturnValue(request.promise);
    const harness = createHookHarness();
    const patch = vi.fn();
    const render = (channelId = "channel") => harness.render(() => TaskClaimConfirmationCard({ message: initial, channelId, currentUserId: "user", onContentDataUpdated: patch }));
    render().props.onResolve("accept");
    if (end === "channel") render("other");
    if (end === "session") clearClientSessionData();
    if (end === "unmount") harness.unmount();
    request.resolve(update("executing", 2));
    await request.promise;
    await Promise.resolve();
    expect(patch).not.toHaveBeenCalled();
    harness.unmount();
  });
});
