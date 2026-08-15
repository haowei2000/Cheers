import { describe, it, expect } from "vitest";
import type { RendererExtension } from "../sandbox/rendererExtension";
import { accepts, candidatesFor, formatOf, getRenderer, previewOptions, specificity } from "./registry";

// A renderer plugin that only accepts markdown containing task lines.
const checklist: RendererExtension = {
  extensionId: "md-checklist",
  title: "Markdown checklist",
  manifest: {
    renderers: [
      { id: "checklist", title: "Checklist", match: { format: "markdown", requireAny: ["- [ ]", "- [x]"] } },
    ],
  },
};

// A renderer plugin that only accepts JSON with a top-level `columns` key.
const kanban: RendererExtension = {
  extensionId: "kb",
  title: "KB",
  manifest: {
    renderers: [{ id: "board", title: "Board", match: { format: "json", jsonHas: ["columns"] } }],
  },
};

const idsOf = (path: string, content: string, extensions: RendererExtension[]) =>
  candidatesFor(path, content, extensions).map((r) => r.id);

describe("formatOf", () => {
  it("maps by extension; unknown => text", () => {
    expect(formatOf("a.md")).toBe("markdown");
    expect(formatOf("a.MARKDOWN")).toBe("markdown");
    expect(formatOf("a.json")).toBe("json");
    expect(formatOf("a.yaml")).toBe("yaml");
    expect(formatOf("a.YML")).toBe("yaml");
    expect(formatOf("a.toml")).toBe("toml");
    expect(formatOf("noext")).toBe("text");
  });
});

describe("accepts — declared acceptance", () => {
  const desc = (m: RendererExtension) => getRenderer(`personal:${m.extensionId}:${m.manifest.renderers![0].id}`, [m])!;

  it("requireAny gates on content", () => {
    const r = desc(checklist);
    expect(accepts(r, "todo.md", "- [ ] do")).toBe(true);
    expect(accepts(r, "notes.md", "just prose, no tasks")).toBe(false);
    expect(accepts(r, "todo.json", "- [ ] do")).toBe(false); // wrong format
  });

  it("jsonHas gates on a parsed top-level key", () => {
    const r = desc(kanban);
    expect(accepts(r, "b.json", '{"columns":[]}')).toBe(true);
    expect(accepts(r, "b.json", '{"other":1}')).toBe(false);
    expect(accepts(r, "b.json", "not json")).toBe(false);
  });

  it("glob narrows by path", () => {
    const p: RendererExtension = {
      extensionId: "g",
      title: "g",
      manifest: { renderers: [{ id: "r", title: "r", match: { format: "markdown", glob: "reviews/*.md" } }] },
    };
    const r = getRenderer("personal:g:r", [p])!;
    expect(accepts(r, "reviews/a.md", "x")).toBe(true);
    expect(accepts(r, "reviews/a/b.md", "x")).toBe(false); // * stops at "/"
    expect(accepts(r, "notes/a.md", "x")).toBe(false);
  });

  it("** in a glob crosses path segments (the \\u0000 placeholder path)", () => {
    const p: RendererExtension = {
      extensionId: "g2",
      title: "g2",
      manifest: {
        renderers: [{ id: "r", title: "r", match: { format: "markdown", glob: "reviews/**/*.md" } }],
      },
    };
    const r = getRenderer("personal:g2:r", [p])!;
    expect(accepts(r, "reviews/a/b/c.md", "x")).toBe(true);
    expect(accepts(r, "notes/a/b.md", "x")).toBe(false);
  });
});

describe("candidatesFor — content-aware, specificity-ordered", () => {
  it("offers only renderers that accept the content", () => {
    expect(idsOf("todo.md", "- [ ] x", [checklist])).toContain("personal:md-checklist:checklist");
    // prose markdown: the checklist plugin is NOT offered, only the built-in markdown
    expect(idsOf("notes.md", "prose", [checklist])).toEqual(["builtin:markdown"]);
  });

  it("orders most-specific first (plugin before generic builtin)", () => {
    const ids = idsOf("todo.md", "- [ ] x", [checklist]);
    expect(ids[0]).toBe("personal:md-checklist:checklist");
    expect(ids).toContain("builtin:markdown");
    expect(specificity(getRenderer("personal:md-checklist:checklist", [checklist])!)).toBeGreaterThan(
      specificity(getRenderer("builtin:markdown", [])!)
    );
  });

  it("excludes shape-uncertain builtins (kanban) and non-matching table from the picker", () => {
    // json OBJECT with `columns`: the plugin board is offered; built-in kanban stays
    // unpickable and built-in table doesn't accept objects (dataKind: array)
    const ids = idsOf("b.json", '{"columns":[]}', [kanban]);
    expect(ids).toContain("personal:kb:board");
    expect(ids).not.toContain("builtin:table");
    expect(ids).not.toContain("builtin:kanban");
    // json object that no renderer accepts → empty candidate list
    expect(idsOf("b.json", '{"x":1}', [kanban])).toEqual([]);
  });
});

describe("yaml as a structured format", () => {
  it("builtin table is offered for JSON and YAML arrays, never for objects", () => {
    expect(idsOf("rows.json", '[{"a":1}]', [])).toContain("builtin:table");
    expect(idsOf("rows.yaml", "- a: 1\n- a: 2\n", [])).toContain("builtin:table");
    expect(idsOf("obj.yaml", "a: 1\n", [])).not.toContain("builtin:table");
    expect(idsOf("prose.yaml", "just a scalar string", [])).not.toContain("builtin:table");
  });

  it("table needs rows that are plain objects — null/scalar rows are never offered", () => {
    // `- name: a` + a bare `-` parses to [{name:"a"}, null]: ONE bad row disqualifies
    // (rendering null rows used to throw all the way to the root ErrorBoundary)
    expect(idsOf("rows.yaml", "- name: a\n-\n", [])).not.toContain("builtin:table");
    // scalar rows: a table would fabricate per-character columns and a cell edit would
    // spread the string into {"0":…} corruption on save
    expect(idsOf("rows.yaml", "- alpha\n- beta\n", [])).not.toContain("builtin:table");
    expect(idsOf("rows.json", "[1, 2]", [])).not.toContain("builtin:table");
    expect(idsOf("rows.json", '[["a"],["b"]]', [])).not.toContain("builtin:table");
    // an empty array has nothing to tabulate (and no keys to infer columns from)
    expect(idsOf("rows.json", "[]", [])).not.toContain("builtin:table");
    // arrays of plain objects keep being offered, json and yaml alike
    expect(idsOf("rows.json", '[{"a":1},{"b":2}]', [])).toContain("builtin:table");
    expect(idsOf("rows.yaml", "- name: a\n- name: b\n", [])).toContain("builtin:table");
  });

  it("dataHas matches parsed YAML top-level keys (chart via `series`)", () => {
    expect(idsOf("m.yaml", "series:\n  - name: s\n    points: []\n", [])).toContain("builtin:chart");
    expect(idsOf("m.yaml", "other: 1\n", [])).not.toContain("builtin:chart");
  });

  it("offers the native codemap renderer only for codemap schema v1", () => {
    expect(idsOf("codemap/map.yaml", "codemap: 1\nnodes: {}\nedges: []\n", [])).toContain("builtin:codemap");
    expect(idsOf("graph.yaml", "nodes: {}\nedges: []\n", [])).not.toContain("builtin:codemap");
  });

  it("jsonHas stays frozen to JSON — it never matches YAML", () => {
    const p: RendererExtension = {
      extensionId: "jh",
      title: "jh",
      manifest: {
        renderers: [{ id: "r", title: "R", match: { format: ["json", "yaml"], jsonHas: ["columns"] } }],
      },
    };
    expect(idsOf("b.json", '{"columns":[]}', [p])).toContain("personal:jh:r");
    expect(idsOf("b.yaml", "columns: []\n", [p])).not.toContain("personal:jh:r");
  });
});

describe("getRenderer", () => {
  it("resolves built-ins (incl. unpickable) and plugin renderers", () => {
    expect(getRenderer("builtin:markdown", [])?.lensId).toBe("markdown");
    expect(getRenderer("builtin:kanban", [])?.pickable).toBe(false);
    expect(getRenderer("personal:md-checklist:checklist", [checklist])?.title).toBe("Checklist");
    expect(getRenderer("nope", [])).toBeUndefined();
  });
});

describe("protocol-1 match vocabulary", () => {
  const plug = (id: string, match: object): RendererExtension => ({
    extensionId: id,
    title: id,
    manifest: { renderers: [{ id: "r", title: "R", match }] },
  });
  const one = (p: RendererExtension) => getRenderer(`personal:${p.extensionId}:r`, [p])!;

  it("format accepts a list of coarse formats", () => {
    const r = one(plug("multi", { format: ["markdown", "json"] }));
    expect(accepts(r, "a.md", "x")).toBe(true);
    expect(accepts(r, "a.json", "{}")).toBe(true);
    expect(accepts(r, "a.toml", "x")).toBe(false);
  });

  it("dataHas gates on parsed top-level keys (like jsonHas, but format-agnostic)", () => {
    const r = one(plug("dh", { format: "json", dataHas: ["series"] }));
    expect(accepts(r, "m.json", '{"series":[]}')).toBe(true);
    expect(accepts(r, "m.json", '{"other":1}')).toBe(false);
    expect(accepts(r, "m.json", "not json")).toBe(false);
  });

  it("dataKind claims the top-level shape — the only way to claim an array", () => {
    const arr = one(plug("arr", { format: "json", dataKind: "array" }));
    expect(accepts(arr, "rows.json", "[{\"a\":1}]")).toBe(true);
    expect(accepts(arr, "rows.json", '{"a":1}')).toBe(false);
    const obj = one(plug("obj", { format: "json", dataKind: "object" }));
    expect(accepts(obj, "o.json", '{"a":1}')).toBe(true);
    expect(accepts(obj, "o.json", "[1]")).toBe(false);
    expect(accepts(obj, "o.json", "null")).toBe(false);
  });

  it("jsonHas keeps its frozen semantics (deprecated alias)", () => {
    const r = one(plug("jh", { format: "json", jsonHas: ["columns"] }));
    expect(accepts(r, "b.json", '{"columns":[]}')).toBe(true);
    expect(accepts(r, "b.json", "[1,2]")).toBe(false); // arrays never satisfy jsonHas
  });

  it("dataHas/dataKind raise specificity like jsonHas does", () => {
    const kind = one(plug("k", { format: "json", dataKind: "array" }));
    const keys = one(plug("d", { format: "json", dataHas: ["a", "b"] }));
    const plain = one(plug("p", { format: "json" }));
    expect(specificity(kind)).toBeGreaterThan(specificity(plain));
    expect(specificity(keys)).toBeGreaterThan(specificity(kind));
  });

});

describe("previewOptions", () => {
  it("falls back from a failed personal renderer to a matching builtin", () => {
    const plugin: RendererExtension = {
      extensionId: "fallback",
      title: "Fallback",
      manifest: {
        renderers: [{ id: "r", title: "R", match: { format: "markdown" } }],
      },
    };
    const failed = "personal:fallback:r";
    expect(previewOptions("notes.md", "# Notes", [plugin], failed, [failed])[0]?.id).toBe("builtin:markdown");
  });
});
