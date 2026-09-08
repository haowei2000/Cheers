import { describe, expect, it } from "vitest";
import { applyPatchOps } from "./patchOps";
import {
  addAnnotationOps,
  annotationId,
  annotationsFor,
  notesOnTarget,
  parseAnnotations,
  removeAnnotationOps,
  resolveAnnotation,
  seedAnnotations,
  type AnnotationDoc,
} from "./annotations";

const raw = () => ({
  annotations: 1,
  notes: [
    { id: "plan-note", path: "dev/plan.yaml", anchor: { path: ["columns", 0] }, label: "Planned", note: "stale" },
    { id: "plan-note-2", path: "dev/plan.yaml", anchor: { text: "Shipped" }, label: "Shipped", note: "rename this" },
    { id: "todo-note", path: "dev/todo.md", label: "dev/todo.md", note: "whole file" },
  ],
});
const parsed = (source: unknown = raw()) => parseAnnotations(source);

describe("parseAnnotations", () => {
  it("drops entries that cannot be shown, and keeps the rest", () => {
    // Same tolerance as every hand-written document here: one bad note must not cost
    // you the others.
    const doc = parsed({
      notes: [
        { id: "ok", path: "a.yaml", note: "keep" },
        { path: "a.yaml", note: "no id" },
        { id: "dup", path: "a.yaml", note: "first" },
        { id: "dup", path: "a.yaml", note: "duplicate id" },
        { id: "blank", path: "a.yaml", note: "   " },
        "not an object",
      ],
    });
    expect(doc.notes.map((note) => note.id)).toEqual(["ok", "dup"]);
  });

  it("carries the RAW index, so an edit lands on the entry the reader sees", () => {
    const doc = parsed({ notes: [{ note: "dropped" }, { id: "real", path: "a.yaml", note: "x" }] });
    expect(doc.notes[0].at).toBe(1);
  });

  it("distinguishes a missing store from an empty one", () => {
    // The first write differs: a file with no `notes` key needs it created.
    expect(parsed({}).seeded).toBe(false);
    expect(parsed({ annotations: 1, notes: [] }).seeded).toBe(true);
  });

  it("falls back to a whole-file anchor rather than inventing one", () => {
    expect(parsed({ notes: [{ id: "a", path: "p", note: "n", anchor: { path: ["ok", {}] } }] }).notes[0].anchor)
      .toEqual({ kind: "file" });
  });
});

describe("anchoring", () => {
  const text = "# The board\ncolumns:\n  - name: Planned\n    items: [a]\n  - name: Shipped\n    items: []\n";

  it("resolves a structural anchor to lines in the CURRENT text", () => {
    // The point of storing a path rather than a line number: this note keeps pointing at
    // the same column no matter what is edited above it.
    const doc = parsed();
    expect(resolveAnnotation(doc.notes[0], text)).toEqual({ start: 3, end: 4 });
    const shifted = `# added\n# lines\n${text}`;
    expect(resolveAnnotation(doc.notes[0], shifted)).toEqual({ start: 5, end: 6 });
  });

  it("reports an anchor that no longer resolves instead of guessing", () => {
    // The row was deleted. The note still exists and still says what it said; it just has
    // nowhere to sit, and that is worth showing rather than silently relocating it.
    expect(resolveAnnotation(parsed().notes[0], "columns: []\n")).toBeNull();
  });

  it("matches a target to the notes already on it", () => {
    const doc = parsed();
    expect(notesOnTarget(doc, "dev/plan.yaml", { label: "Planned", sourcePath: ["columns", 0] }).map((n) => n.id))
      .toEqual(["plan-note"]);
    expect(notesOnTarget(doc, "dev/plan.yaml", { label: "x", sourcePath: ["columns", 1] })).toEqual([]);
  });

  it("keeps each file's notes to itself", () => {
    expect(annotationsFor(parsed(), "dev/todo.md").map((n) => n.id)).toEqual(["todo-note"]);
  });
});

describe("writing", () => {
  const entry = { path: "dev/plan.yaml", anchor: { kind: "path" as const, sourcePath: ["columns", 1] }, label: "In progress", note: "  needs an owner  " };

  it("appends, trims, and names the note after what it annotates", () => {
    const ops = addAnnotationOps(parsed(), entry);
    expect(ops).toEqual([{
      op: "insert",
      path: ["notes"],
      index: 3,
      value: { id: "plan-note-3", path: "dev/plan.yaml", anchor: { path: ["columns", 1] }, label: "In progress", note: "needs an owner" },
    }]);
  });

  it("creates the notes key when the file has none", () => {
    const ops = addAnnotationOps(parsed({ annotations: 1 }), entry);
    expect(ops[0]).toEqual({ op: "set", path: ["notes"], value: [] });
    expect(ops).toHaveLength(2);
  });

  it("refuses an empty note", () => {
    expect(addAnnotationOps(parsed(), { ...entry, note: "   " })).toEqual([]);
  });

  it("seeds a whole document when there is no file to patch", () => {
    // fs.patch cannot address a file that does not exist, so the first note is a write.
    expect(seedAnnotations({ notes: [], seeded: false }, entry)).toEqual({
      annotations: 1,
      notes: [{ id: "plan-note", path: "dev/plan.yaml", anchor: { path: ["columns", 1] }, label: "In progress", note: "needs an owner" }],
    });
  });

  it("removes by id and leaves a readable document", () => {
    const before = raw();
    const doc: AnnotationDoc = parseAnnotations(before);
    const after = applyPatchOps(before, removeAnnotationOps(doc, "plan-note-2"));
    expect(parseAnnotations(after).notes.map((n) => n.id)).toEqual(["plan-note", "todo-note"]);
  });

  it("does nothing for a note that is not there", () => {
    expect(removeAnnotationOps(parsed(), "ghost")).toEqual([]);
  });

  it("disambiguates ids without making them unreadable", () => {
    expect(annotationId(parsed(), "dev/issues.yaml")).toBe("issues-note");
    expect(annotationId(parsed(), "dev/plan.yaml")).toBe("plan-note-3");
  });
});
