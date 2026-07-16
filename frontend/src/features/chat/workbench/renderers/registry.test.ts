import { describe, it, expect } from "vitest";
import type { PluginMeta } from "../sandbox/api";
import { accepts, candidatesFor, formatOf, getRenderer, specificity } from "./registry";

// A renderer plugin that only accepts markdown containing task lines.
const checklist: PluginMeta = {
  plugin_id: "md-checklist",
  title: "Markdown checklist",
  manifest: {
    id: "md-checklist",
    title: "Markdown checklist",
    renderers: [
      { id: "checklist", title: "Checklist", match: { format: "markdown", requireAny: ["- [ ]", "- [x]"] } },
    ],
  },
};

// A renderer plugin that only accepts JSON with a top-level `columns` key.
const kanban: PluginMeta = {
  plugin_id: "kb",
  title: "KB",
  manifest: {
    renderers: [{ id: "board", title: "Board", match: { format: "json", jsonHas: ["columns"] } }],
  },
};

const idsOf = (path: string, content: string, plugins: PluginMeta[]) =>
  candidatesFor(path, content, plugins).map((r) => r.id);

describe("formatOf", () => {
  it("maps by extension; unknown => text", () => {
    expect(formatOf("a.md")).toBe("markdown");
    expect(formatOf("a.MARKDOWN")).toBe("markdown");
    expect(formatOf("a.json")).toBe("json");
    expect(formatOf("a.toml")).toBe("toml");
    expect(formatOf("noext")).toBe("text");
  });
});

describe("accepts — declared acceptance", () => {
  const desc = (m: PluginMeta) => getRenderer(`plugin:${m.plugin_id}:${m.manifest.renderers![0].id}`, [m])!;

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
    const p: PluginMeta = {
      plugin_id: "g",
      title: "g",
      manifest: { renderers: [{ id: "r", title: "r", match: { format: "markdown", glob: "reviews/*.md" } }] },
    };
    const r = getRenderer("plugin:g:r", [p])!;
    expect(accepts(r, "reviews/a.md", "x")).toBe(true);
    expect(accepts(r, "notes/a.md", "x")).toBe(false);
  });
});

describe("candidatesFor — content-aware, specificity-ordered", () => {
  it("offers only renderers that accept the content", () => {
    expect(idsOf("todo.md", "- [ ] x", [checklist])).toContain("plugin:md-checklist:checklist");
    // prose markdown: the checklist plugin is NOT offered, only the built-in markdown
    expect(idsOf("notes.md", "prose", [checklist])).toEqual(["builtin:markdown"]);
  });

  it("orders most-specific first (plugin before generic builtin)", () => {
    const ids = idsOf("todo.md", "- [ ] x", [checklist]);
    expect(ids[0]).toBe("plugin:md-checklist:checklist");
    expect(ids).toContain("builtin:markdown");
    expect(specificity(getRenderer("plugin:md-checklist:checklist", [checklist])!)).toBeGreaterThan(
      specificity(getRenderer("builtin:markdown", [])!)
    );
  });

  it("excludes config-needing builtins (table/kanban) from the picker", () => {
    // json with `columns`: the plugin board is offered; built-in table/kanban are NOT (pickable=false)
    const ids = idsOf("b.json", '{"columns":[]}', [kanban]);
    expect(ids).toContain("plugin:kb:board");
    expect(ids).not.toContain("builtin:table");
    expect(ids).not.toContain("builtin:kanban");
    // json that no renderer accepts → empty candidate list
    expect(idsOf("b.json", '{"x":1}', [kanban])).toEqual([]);
  });
});

describe("getRenderer", () => {
  it("resolves built-ins (incl. unpickable) and plugin renderers", () => {
    expect(getRenderer("builtin:markdown", [])?.lensId).toBe("markdown");
    expect(getRenderer("builtin:table", [])?.pickable).toBe(false);
    expect(getRenderer("plugin:md-checklist:checklist", [checklist])?.title).toBe("Checklist");
    expect(getRenderer("nope", [])).toBeUndefined();
  });
});

describe("protocol-1 match vocabulary", () => {
  const plug = (id: string, match: object): PluginMeta => ({
    plugin_id: id,
    title: id,
    manifest: { id, title: id, renderers: [{ id: "r", title: "R", match }] },
  });
  const one = (p: PluginMeta) => getRenderer(`plugin:${p.plugin_id}:r`, [p])!;

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

  it("a manifest declaring an unimplemented protocol contributes nothing", () => {
    const future: PluginMeta = {
      plugin_id: "future",
      title: "Future",
      manifest: {
        id: "future",
        title: "Future",
        protocol: 2,
        renderers: [{ id: "r", title: "R", match: { format: "markdown" } }],
      },
    };
    expect(idsOf("a.md", "x", [future])).toEqual(["builtin:markdown"]);
    // explicit protocol 1 is the default and fully served
    const v1: PluginMeta = { ...future, plugin_id: "v1", manifest: { ...future.manifest, id: "v1", protocol: 1 } };
    expect(idsOf("a.md", "x", [v1])).toContain("plugin:v1:r");
  });
});
