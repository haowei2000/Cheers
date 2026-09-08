import { describe, expect, it } from "vitest";
import { normalizeResolvedSceneItem } from "./api";

describe("official scene compatibility", () => {
  it("normalizes the published v1 file/renderer response", () => {
    expect(normalizeResolvedSceneItem({
      id: "notes", title: "Notes", file: "notes.md", renderer: "builtin:markdown",
    })).toMatchObject({ source: { kind: "fs", path: "notes.md" }, view: "builtin:markdown" });
  });

  it("accepts the normalized response during a rolling deploy", () => {
    expect(normalizeResolvedSceneItem({
      id: "notes", title: "Notes", source: { kind: "fs", path: "notes.md" }, view: "builtin:markdown",
    })).toMatchObject({ source: { kind: "fs", path: "notes.md" }, view: "builtin:markdown" });
  });
});
