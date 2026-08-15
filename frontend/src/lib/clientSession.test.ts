import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearClientSessionData } from "./clientSession";

function storage(initial: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("clearClientSessionData", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "sessionStorage",
      storage({ "cheers.draft.channel-1": "secret draft", "unrelated.key": "keep" }),
    );
  });

  it("removes Cheers drafts without clearing unrelated tab state", () => {
    clearClientSessionData();
    expect(sessionStorage.getItem("cheers.draft.channel-1")).toBeNull();
    expect(sessionStorage.getItem("unrelated.key")).toBe("keep");
  });
});
