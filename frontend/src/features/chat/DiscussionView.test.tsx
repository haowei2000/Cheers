import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createHookHarness } from "@/test/hookHarness";
import { getDiscussion, listDiscussions, type DiscussionDetailResponse } from "@/api/discussions";
import { DiscussionView } from "./DiscussionView";

const selection = vi.hoisted(() => ({ current: "topic-A" }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), ...await import("@/test/hookHarness") }));
vi.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams({ discussion: selection.current }), vi.fn()] }));
vi.mock("@/api/discussions", () => ({ getDiscussion: vi.fn(), listDiscussions: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

type ButtonNode = ReactElement<{ children?: ReactNode; disabled?: boolean; onClick: () => void }>;
function olderButton(node: ReactNode): ButtonNode | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) continue;
    if (Children.toArray(child.props.children).includes("Load older replies")) return child as ButtonNode;
    const found = olderButton(child.props.children);
    if (found) return found;
  }
}
const detail = (id: string): DiscussionDetailResponse => ({
  root: { msg_id: id, sender_id: "user", sender_type: "user", content: id, channel_seq: 1 },
  replies: [{ msg_id: `${id}-reply`, sender_id: "bot", sender_type: "bot", content: "Reply", channel_seq: 10 }],
  meta: { has_more_before: true, limit: 50 },
});

it("resets older-page busy on topic switch and an old completion cannot clear the new request", async () => {
  vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: vi.fn() }, setTimeout, clearTimeout });
  vi.mocked(listDiscussions).mockResolvedValue({ discussions: [], meta: { has_more: false } });
  let finishA!: (value: DiscussionDetailResponse) => void;
  let finishB!: (value: DiscussionDetailResponse) => void;
  vi.mocked(getDiscussion).mockImplementation((_channel, id, opts) => {
    if (!opts?.before) return Promise.resolve(detail(id));
    return new Promise((resolve) => { if (id === "topic-A") finishA = resolve; else finishB = resolve; });
  });
  const harness = createHookHarness();
  const onComposerContextChange = vi.fn();
  const render = () => harness.render(() => DiscussionView({ channelId: "channel", realtimeVersion: 0, onComposerContextChange }));
  render();
  await vi.waitFor(() => expect(olderButton(render())).toBeDefined());
  olderButton(render())!.props.onClick();
  expect(olderButton(render())!.props.disabled).toBe(true);
  selection.current = "topic-B";
  render();
  await vi.waitFor(() => expect(olderButton(render())?.props.disabled).toBe(false));
  olderButton(render())!.props.onClick();
  expect(olderButton(render())!.props.disabled).toBe(true);
  finishA(detail("topic-A"));
  await Promise.resolve();
  await Promise.resolve();
  expect(olderButton(render())!.props.disabled).toBe(true);
  finishB(detail("topic-B"));
  await vi.waitFor(() => expect(olderButton(render())!.props.disabled).toBe(false));
  harness.unmount();
});
