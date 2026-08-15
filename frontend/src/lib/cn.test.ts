import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("design-system class merging", () => {
  it("keeps typography and foreground color as independent class groups", () => {
    expect(cn("text-content-on-light", "text-regular")).toContain("text-content-on-light");
    expect(cn("text-content-on-light", "text-regular")).toContain("text-regular");
    expect(cn("text-regular", "text-content-on-light")).toContain("text-regular");
  });

  it("still resolves multiple typography tiers to the last registered tier", () => {
    expect(cn("text-compact", "text-regular", "text-content-on-light")).toBe("text-regular text-content-on-light");
  });
});
