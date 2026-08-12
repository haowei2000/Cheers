import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("design-system class merging", () => {
  it("keeps typography and foreground color as independent class groups", () => {
    expect(cn("text-zinc-950", "text-regular")).toContain("text-zinc-950");
    expect(cn("text-zinc-950", "text-regular")).toContain("text-regular");
    expect(cn("text-regular", "text-zinc-950")).toContain("text-regular");
  });

  it("still resolves multiple typography tiers to the last registered tier", () => {
    expect(cn("text-compact", "text-regular", "text-zinc-950")).toBe("text-regular text-zinc-950");
  });
});
