import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPersonalExtensionDisabled,
  personalExtensionStatus,
  reportRendererStatus,
  setPersonalExtensionDisabled,
} from "./runtime";

describe("extension runtime state", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
  });

  it("persists personal extension disabled state", () => {
    setPersonalExtensionDisabled("example", true);
    expect(isPersonalExtensionDisabled("example")).toBe(true);
    setPersonalExtensionDisabled("example", false);
    expect(isPersonalExtensionDisabled("example")).toBe(false);
  });

  it("tracks real renderer failures", () => {
    reportRendererStatus("runtime-example", "failed", "activation failed");
    expect(personalExtensionStatus("runtime-example")).toEqual({
      status: "failed",
      error: "activation failed",
    });
  });
});
