import { describe, expect, it } from "vitest";
import { builtinView, viewFor, VIEW_SUFFIXES } from "./registry";
import { viewChange } from "./viewChanges";
import type { RendererExtension } from "../sandbox/rendererExtension";
const extension = (id: string, suffix?: string): RendererExtension => ({ extensionId: id, title: id,
  manifest: { renderers: [{ id: "view", title: id, match: suffix ? { suffix } : { format: "yaml" } }] } });

describe("filename-selected views", () => {
  it("uses every shared suffix, case insensitively", () => {
    for (const row of VIEW_SUFFIXES) for (const suffix of row.suffixes) {
      expect(builtinView(`folder/REPORT${suffix.toUpperCase()}`)).toBe(row.view);
    }
  });
  it("does not infer a view from a generic structured file or directory name", () => {
    expect(viewFor("rows.json")).toBeUndefined();
    expect(viewFor("board.canvas.yaml/data.txt")).toBeUndefined();
    expect(viewFor("board.kanban.yaml")?.id).toBe("builtin:kanban");
  });
  it("uses the longest suffix and ignores legacy content rules", () => {
    expect(viewFor("report.gantt.yaml", [extension("wide", ".yaml"), extension("gantt", ".gantt.yaml")])?.id).toBe("personal:gantt:view");
    expect(viewFor("report.yaml", [extension("legacy")])).toBeUndefined();
  });
  it("reserves built-ins and disables duplicate extension claims", () => {
    expect(viewFor("report.md", [extension("override", ".md")])?.id).toBe("builtin:markdown");
    expect(viewFor("report.gantt.yaml", [extension("one", ".gantt.yaml"), extension("two", ".GANTT.YAML")])).toBeUndefined();
  });
  it("suggests a rename without changing existing files", () => {
    expect(viewChange("rows.json", '[{"a":1}]', [])).toEqual({ previous: "表格", current: "Source", suggestedPath: "rows.table.json" });
    expect(viewChange("notes.md", "notes", [])).toBeUndefined();
    expect(viewChange("board.yaml", "columns: []", [], "builtin:kanban")?.suggestedPath).toBe("board.kanban.yaml");
  });
});
