import { describe, expect, it, vi } from "vitest";
import { createInteractionDispatcher } from "./interaction";
import type { ResourceInteraction } from "./interaction";

describe("shared Workbench interaction boundary", () => {
  it("awaits the structured request receipt and preserves its retry identity", async () => {
    const event: ResourceInteraction = { v: 1, sourceUri: "cheers:desk/forms/report.a2ui.json", sourceVersion: 3,
      surfaceId: "report", componentId: "submit", actionId: "report.prepare", botId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      invocationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", input: { topic: "UI", sources: true } };
    const requestInteraction = vi.fn().mockResolvedValue({ msg_id: "receipt" });
    const dispatch = createInteractionDispatcher({ requestInteraction });
    expect(dispatch.capabilities).toEqual(["request"]);
    expect(await dispatch({ kind: "request", event })).toEqual({ ok: true, outcome: "requested", messageId: "receipt" });
    expect(requestInteraction).toHaveBeenCalledWith(event);
    expect(requestInteraction.mock.calls[0][0].input).not.toBe(event.input);
    requestInteraction.mockRejectedValueOnce(new Error("The resource changed. Reload it."));
    expect(await dispatch({ kind: "request", event })).toEqual({ ok: false, error: "The resource changed. Reload it." });
    expect((await dispatch({ kind: "request", event: { ...event, sourceVersion: 0 } })).ok).toBe(false);
    expect(requestInteraction).toHaveBeenCalledTimes(2);
  });
  it("accepts native handoff results only through the registered adapter", async () => {
    const openNative = vi.fn().mockResolvedValue("downloaded-copy");
    const dispatch = createInteractionDispatcher({ openNative });
    expect(await dispatch({ kind: "openNative", uri: "cheers:desk/a.txt", opener: "zed" })).toEqual({ ok: true, outcome: "downloaded-copy" });
    expect((await dispatch({ kind: "openNative", uri: "cheers:desk/a.txt", opener: "shell" })).ok).toBe(false);
    expect(openNative).toHaveBeenCalledTimes(1);
  });
  it("routes a resource URI through the host and refuses unsafe links", async () => {
    const openLocator = vi.fn();
    const dispatch = createInteractionDispatcher({ openLocator });
    expect(await dispatch({ kind: "open", uri: "cheers:desk/forms/report.json" })).toEqual({ ok: true, outcome: "opened" });
    expect((await dispatch({ kind: "open", uri: "javascript:alert(1)" })).ok).toBe(false);
    expect(openLocator).toHaveBeenCalledTimes(1);
    expect(openLocator).toHaveBeenCalledWith("cheers:desk/forms/report.json");
  });
  it("prepares a draft without sending a message or executing a native command", async () => {
    const composeMessage = vi.fn();
    const dispatch = createInteractionDispatcher({ composeMessage });
    expect(await dispatch({ kind: "compose", actionId: "report.prepare", formData: { topic: "UI", sources: true } })).toEqual({ ok: true, outcome: "drafted" });
    expect(composeMessage).toHaveBeenCalledWith("[Action report.prepare] topic: UI, sources: true");
  });
  it("uses the same boundary for legacy form callbacks with a detached payload", async () => {
    const onFormSubmit = vi.fn();
    const formData = { nested: { value: 1 } };
    const result = await createInteractionDispatcher({ onFormSubmit })({ kind: "compose", actionId: "submit", formData });
    expect(result.ok).toBe(true);
    const received = onFormSubmit.mock.calls[0][0].formData;
    expect(received).toEqual(formData);
    expect(received.nested).not.toBe(formData.nested);
  });
  it("reports absent capabilities, oversized inputs, and host failures", async () => {
    const absent = createInteractionDispatcher({});
    expect((await absent({ kind: "open", uri: "cheers:plan" })).ok).toBe(false);
    expect((await absent({ kind: "compose", actionId: "submit", formData: {} })).ok).toBe(false);
    const callback = vi.fn();
    const dispatch = createInteractionDispatcher({ composeMessage: callback });
    expect((await dispatch({ kind: "compose", actionId: "submit", formData: { huge: "x".repeat(20_001) } })).ok).toBe(false);
    expect((await dispatch({ kind: "compose", actionId: "bad\nlabel", formData: {} })).ok).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    expect((await createInteractionDispatcher({ openLocator: () => { throw new Error("offline"); } })({ kind: "open", uri: "cheers:plan" })).ok).toBe(false);
  });
});
