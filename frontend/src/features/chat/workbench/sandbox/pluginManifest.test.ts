import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "./pluginManifest";

const ok = {
  id: "md-checklist",
  title: "Markdown checklist",
  renderers: [{ id: "checklist", title: "Checklist", match: { format: "markdown" } }],
};

describe("validatePluginManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validatePluginManifest(ok)).toBeNull();
  });

  it("accepts a renderer without match (match is optional)", () => {
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r", title: "R" }] })
    ).toBeNull();
  });

  it("accepts multiple renderers with distinct ids", () => {
    expect(
      validatePluginManifest({
        ...ok,
        renderers: [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
        ],
      })
    ).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(validatePluginManifest(null)).toMatch(/object/);
    expect(validatePluginManifest("hi")).toMatch(/object/);
    expect(validatePluginManifest([ok])).toMatch(/object/);
  });

  it("rejects missing/empty id or title", () => {
    expect(validatePluginManifest({ ...ok, id: undefined })).toMatch(/id/);
    expect(validatePluginManifest({ ...ok, id: "  " })).toMatch(/id/);
    expect(validatePluginManifest({ ...ok, title: undefined })).toMatch(/title/);
    expect(validatePluginManifest({ ...ok, title: "" })).toMatch(/title/);
  });

  it("rejects missing or empty renderers (incl. retired panels-only manifests)", () => {
    expect(validatePluginManifest({ id: "x", title: "X" })).toMatch(/renderers/);
    expect(validatePluginManifest({ id: "x", title: "X", renderers: [] })).toMatch(/renderers/);
    // a legacy scenario plugin declares panels but no renderers — same rejection path
    expect(
      validatePluginManifest({ id: "x", title: "X", panels: [{ id: "notes", title: "Notes" }] })
    ).toMatch(/renderers/);
  });

  it("rejects malformed renderer entries", () => {
    expect(validatePluginManifest({ ...ok, renderers: ["nope"] })).toMatch(/renderer/);
    expect(validatePluginManifest({ ...ok, renderers: [{ title: "no id" }] })).toMatch(/id/);
    expect(validatePluginManifest({ ...ok, renderers: [{ id: "r" }] })).toMatch(/title/);
  });

  it("rejects duplicate renderer ids within a plugin", () => {
    expect(
      validatePluginManifest({
        ...ok,
        renderers: [
          { id: "dup", title: "One" },
          { id: "dup", title: "Two" },
        ],
      })
    ).toMatch(/duplicate/);
  });

  it("rejects a non-object match", () => {
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r", title: "R", match: "markdown" }] })
    ).toMatch(/match/);
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r", title: "R", match: ["markdown"] }] })
    ).toMatch(/match/);
  });
});
