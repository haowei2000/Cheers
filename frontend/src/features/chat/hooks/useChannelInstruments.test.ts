import { describe, expect, it } from "vitest";
import { resolveBooleanUpdate } from "./useChannelInstruments";

describe("resolveBooleanUpdate", () => {
  it("resolves direct and functional panel-open updates", () => {
    expect(resolveBooleanUpdate(false, true)).toBe(true);
    expect(resolveBooleanUpdate(false, (open) => !open)).toBe(true);
    expect(resolveBooleanUpdate(true, (open) => !open)).toBe(false);
  });
});
