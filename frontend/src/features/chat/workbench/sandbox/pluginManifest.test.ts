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

  it("rejects missing or empty renderers", () => {
    expect(validatePluginManifest({ id: "x", title: "X" })).toMatch(/renderers/);
    expect(validatePluginManifest({ id: "x", title: "X", renderers: [] })).toMatch(/renderers/);
  });

  it("rejects retired panels manifests with a dedicated message", () => {
    expect(
      validatePluginManifest({ id: "x", title: "X", panels: [{ id: "notes", title: "Notes" }] })
    ).toMatch(/legacy|panels/);
    // even alongside renderers — a mixed manifest is a legacy manifest
    expect(
      validatePluginManifest({ ...ok, panels: [] })
    ).toMatch(/legacy|panels/);
  });

  it("accepts protocol 1 (or absent) and rejects anything else", () => {
    expect(validatePluginManifest({ ...ok, protocol: 1 })).toBeNull();
    expect(validatePluginManifest({ ...ok, protocol: 2 })).toMatch(/protocol/);
    expect(validatePluginManifest({ ...ok, protocol: "1" })).toMatch(/protocol/);
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

  // Parity with the server's validate_manifest (server/src/domain/workbench_plugins.rs):
  // whatever session-loads here must also install there.

  it("rejects ids outside ^[a-z0-9][a-z0-9._-]{0,63}$ (server id charset)", () => {
    expect(validatePluginManifest({ ...ok, id: "Bad_Upper" })).toMatch(/id/);
    expect(validatePluginManifest({ ...ok, id: "-leading-dash" })).toMatch(/id/);
    expect(validatePluginManifest({ ...ok, id: "has space" })).toMatch(/id/);
    expect(validatePluginManifest({ ...ok, id: "x".repeat(65) })).toMatch(/id/);
    expect(validatePluginManifest({ ...ok, id: "x".repeat(64) })).toBeNull();
  });

  it("rejects over-long titles and renderer ids (server byte caps)", () => {
    expect(validatePluginManifest({ ...ok, title: "x".repeat(256) })).toMatch(/title/);
    expect(validatePluginManifest({ ...ok, title: "x".repeat(255) })).toBeNull();
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r".repeat(65), title: "R" }] })
    ).toMatch(/id/);
  });

  it("type-checks known match keys but ignores unknown ones", () => {
    expect(
      validatePluginManifest({
        ...ok,
        renderers: [
          {
            id: "r",
            title: "R",
            match: {
              format: ["json", "yaml"],
              dataKind: "array",
              dataHas: ["rows"],
              futureKey: { anything: true },
            },
          },
        ],
      })
    ).toBeNull();
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r", title: "R", match: { dataKind: "tuple" } }] })
    ).toMatch(/dataKind/);
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r", title: "R", match: { format: [] } }] })
    ).toMatch(/format/);
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r", title: "R", match: { format: [1] } }] })
    ).toMatch(/format/);
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r", title: "R", match: { requireAll: "x" } }] })
    ).toMatch(/requireAll/);
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r", title: "R", match: { jsonHas: [1] } }] })
    ).toMatch(/jsonHas/);
    expect(
      validatePluginManifest({ ...ok, renderers: [{ id: "r", title: "R", match: { glob: 5 } }] })
    ).toMatch(/glob/);
  });
});
