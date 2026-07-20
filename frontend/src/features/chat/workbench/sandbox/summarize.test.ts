import { describe, expect, it } from "vitest";
import { summarize } from "./SandboxRenderer";

// The dev protocol inspector logs plugin-controlled messages. summarize() must survive
// anything a plugin posts — the panel exists to diagnose broken plugins, so it cannot
// itself break on one.
describe("summarize", () => {
  it("drops the type (it is shown separately) and keeps the rest", () => {
    expect(summarize({ type: "cheers:saved", ok: true, version: 7 })).toBe("ok=true version=7");
  });

  it("quotes strings so empty and whitespace payloads stay visible", () => {
    expect(summarize({ type: "cheers:unsupported", reason: "" })).toBe('reason=""');
  });

  it("truncates long content — this is a traffic log, not a data viewer", () => {
    const out = summarize({ type: "cheers:render", content: "x".repeat(500) });
    expect(out.length).toBeLessThan(120);
    expect(out).toContain("…");
  });

  it("skips undefined fields rather than printing them", () => {
    expect(summarize({ type: "cheers:saved", ok: false, version: undefined })).toBe("ok=false");
  });

  it("renders nested objects as JSON", () => {
    expect(summarize({ type: "cheers:resource", params: { channel_id: "c1" } })).toBe(
      'params={"channel_id":"c1"}'
    );
  });

  it("does not throw on a cyclic payload", () => {
    const cyclic: Record<string, unknown> = { type: "cheers:log" };
    cyclic.self = cyclic;
    expect(() => summarize(cyclic)).not.toThrow();
    expect(summarize(cyclic)).toContain("[unserializable]");
  });

  it("returns an empty string for a payload-free message", () => {
    expect(summarize({ type: "cheers:ready" })).toBe("");
  });
});
