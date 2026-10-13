import { describe, expect, it, vi } from "vitest";
import { createArtifactRequestGate, type ArtifactRequestState } from "./artifactRequestGate";
import type { ResourceInteraction } from "../interaction";

const event: ResourceInteraction = {
  v: 1, sourceUri: "cheers:desk/form.tsx", sourceVersion: 1,
  surfaceId: "root", componentId: "submit", actionId: "submit",
  botId: "11111111-2222-3333-4444-555555555555",
  invocationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", input: { topic: "Original" },
};

describe("artifact host request approval", () => {
  it("initialization and synthetic confirmation cannot send; later proposals cannot replace input", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, outcome: "requested" });
    const publish = vi.fn();
    const gate = createArtifactRequestGate(send, publish);
    gate.propose(event);
    gate.propose({ ...event, input: { topic: "Replacement" } });
    await gate.confirm(false);
    expect(send).not.toHaveBeenCalled();
    await gate.confirm(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(event);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ busy: false, result: { ok: true } });
  });
  it("publishes failures, preserves the retry id, and consumes success", async () => {
    let state: ArtifactRequestState = { busy: false };
    const send = vi.fn().mockResolvedValueOnce({ ok: false, error: "Source changed" })
      .mockResolvedValueOnce({ ok: true, outcome: "requested" });
    const gate = createArtifactRequestGate(send, next => { state = next; });
    gate.propose(event);
    await gate.confirm(true);
    expect(state).toMatchObject({ pending: event, result: { ok: false, error: "Source changed" } });
    await gate.confirm(true);
    await gate.confirm(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].invocationId).toBe(event.invocationId);
    expect(state.pending).toBeUndefined();
  });
  it("cancels without sending and invalidates approval when the resource changes", async () => {
    const send = vi.fn();
    const gate = createArtifactRequestGate(send, vi.fn());
    gate.propose(event);
    gate.cancel();
    await gate.confirm(true);
    gate.propose(event);
    gate.dispose();
    await gate.confirm(true);
    expect(send).not.toHaveBeenCalled();
  });
  it("blocks duplicate clicks while a request is running", async () => {
    let complete!: (result: { ok: true; outcome: "requested" }) => void;
    const send = vi.fn(() => new Promise<{ ok: true; outcome: "requested" }>(resolve => { complete = resolve; }));
    const gate = createArtifactRequestGate(send, vi.fn());
    gate.propose(event);
    const pending = gate.confirm(true);
    await gate.confirm(true);
    expect(send).toHaveBeenCalledTimes(1);
    complete({ ok: true, outcome: "requested" });
    await pending;
  });
});
