import { afterEach, describe, expect, it, vi } from "vitest";
import { clearComposerDrafts, persistComposerMentions, restoreComposerMentions, persistSuggestionBindings, restoreSuggestionBindings } from "./composerDrafts";

describe("suggestion draft restoration", () => {
  afterEach(() => { clearComposerDrafts(); vi.unstubAllGlobals(); });

  it("keeps identity and context bindings through a page reload", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const bindings = [
      { key: "who", insertedText: "@Ada", mention: { id: "bot-1", label: "Ada", type: "bot" as const } },
      { key: "view", insertedText: "Plan", context: { id: "plan", verb: "channel.plan.read", params: {}, label: "Plan", kind: "plan" as const } },
    ];
    persistSuggestionBindings("channel-1", bindings);
    expect(restoreSuggestionBindings("channel-1")).toEqual(bindings);
    persistSuggestionBindings("channel-1", []);
    expect(restoreSuggestionBindings("channel-1")).toEqual([]);
  });

  it("restores mention identities per channel and removes cleared recipients", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const picked = [{ id: "bot-1", label: "Ada", type: "bot" as const }];
    persistComposerMentions("channel-1", picked);
    clearComposerDrafts();
    expect(restoreComposerMentions("channel-1")).toEqual(picked);
    expect(restoreComposerMentions("channel-2")).toEqual([]);
    persistComposerMentions("channel-1", []);
    expect(restoreComposerMentions("channel-1")).toEqual([]);
  });

  it("ignores malformed stored identities", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify([{ id: "a" }, null, { id: 123, type: "bot", label: "Bot" }]) });
    expect(restoreComposerMentions("channel-1")).toEqual([]);
  });
});
