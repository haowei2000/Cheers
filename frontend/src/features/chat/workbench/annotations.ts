import { useCallback, useMemo } from "react";
import type { FsClient } from "./fsClient";
import { useFileSession } from "./jsonFile";
import type { PatchOp } from "./patchOps";
import { sourcePathLineRange, uniqueSourceTextRange, type SourceLineRange } from "./contextSource";
import type { LensContextTarget } from "./lens/registry";

// Notes anchored to a part of a workspace file.
//
// They live in a FILE (`annotations.yaml`) rather than in the annotated document,
// because the document belongs to whoever is editing it and a note is a different
// person's remark about it. That also makes them ordinary substrate: an agent reads
// them with `fs.read` like anything else, no new verb and no new store.
//
// The anchor is STRUCTURAL where the lens can give one (`["columns", 0]`), not a line
// number. A line range is resolved from it at read time, so a note survives every edit
// above it — which is most edits. `sourceText` is the fallback for prose, and a note
// with neither anchors to the file as a whole.

export const ANNOTATIONS_PATH = "annotations.yaml";

export type AnnotationAnchor =
  | { kind: "path"; sourcePath: ReadonlyArray<string | number> }
  | { kind: "text"; sourceText: string }
  | { kind: "file" };

export interface Annotation {
  id: string;
  /** RAW index in `notes`, so an edit addresses the entry the reader is looking at even
   *  when malformed entries ahead of it were dropped. Same contract as CanvasNode.at. */
  at: number;
  path: string;
  anchor: AnnotationAnchor;
  /** What the anchor was called when the note was written — the only thing left to show
   *  when the anchor no longer resolves. */
  label: string;
  note: string;
  created?: string;
}

export interface AnnotationDoc {
  notes: Annotation[];
  /** True when the file had a `notes` key at all, so a first write knows whether it is
   *  creating the document or appending to it. */
  seeded: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAnchor(raw: unknown): AnnotationAnchor {
  if (!isObject(raw)) return { kind: "file" };
  if (Array.isArray(raw.path)) {
    const sourcePath = raw.path.filter((part): part is string | number =>
      typeof part === "string" || typeof part === "number"
    );
    return sourcePath.length === raw.path.length ? { kind: "path", sourcePath } : { kind: "file" };
  }
  if (typeof raw.text === "string" && raw.text) return { kind: "text", sourceText: raw.text };
  return { kind: "file" };
}

/** Tolerant, like every other document a person or an agent hand-writes here: a bad
 *  entry is dropped rather than failing the whole file. */
export function parseAnnotations(raw: unknown): AnnotationDoc {
  if (!isObject(raw) || !Array.isArray(raw.notes)) return { notes: [], seeded: false };
  const seen = new Set<string>();
  const notes: Annotation[] = [];
  raw.notes.forEach((entry, at) => {
    if (!isObject(entry)) return;
    const { id, path, note } = entry;
    if (typeof id !== "string" || !id || seen.has(id)) return;
    if (typeof path !== "string" || !path) return;
    if (typeof note !== "string" || !note.trim()) return;
    seen.add(id);
    notes.push({
      id,
      at,
      path,
      anchor: parseAnchor(entry.anchor),
      label: typeof entry.label === "string" ? entry.label : path,
      note,
      created: typeof entry.created === "string" ? entry.created : undefined,
    });
  });
  return { notes, seeded: true };
}

export function annotationsFor(doc: AnnotationDoc, path: string): Annotation[] {
  return doc.notes.filter((note) => note.path === path);
}

export function anchorOf(target: LensContextTarget): AnnotationAnchor {
  if (target.sourcePath) return { kind: "path", sourcePath: target.sourcePath };
  if (target.sourceText !== undefined) return { kind: "text", sourceText: target.sourceText };
  return { kind: "file" };
}

/** Two anchors name the same part of a document. Used to show a target's existing notes
 *  in the same menu that creates them. */
export function sameAnchor(a: AnnotationAnchor, b: AnnotationAnchor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "path" && b.kind === "path") {
    return a.sourcePath.length === b.sourcePath.length &&
      a.sourcePath.every((part, index) => part === b.sourcePath[index]);
  }
  if (a.kind === "text" && b.kind === "text") return a.sourceText === b.sourceText;
  return true;
}

export function notesOnTarget(doc: AnnotationDoc, path: string, target: LensContextTarget): Annotation[] {
  const anchor = anchorOf(target);
  return annotationsFor(doc, path).filter((note) => sameAnchor(note.anchor, anchor));
}

/** Where the note points, in the CURRENT text. Null when the anchor no longer resolves —
 *  the row was deleted, the prose rewritten — which is a fact worth showing, not an error
 *  to swallow: the note is still there, it just no longer has a place to sit. */
export function resolveAnnotation(note: Annotation, text: string): SourceLineRange | null {
  if (note.anchor.kind === "path") return sourcePathLineRange(text, note.anchor.sourcePath);
  if (note.anchor.kind === "text") return uniqueSourceTextRange(text, note.anchor.sourceText);
  return null;
}

function serializeAnchor(anchor: AnnotationAnchor): Record<string, unknown> | undefined {
  if (anchor.kind === "path") return { path: [...anchor.sourcePath] };
  if (anchor.kind === "text") return { text: anchor.sourceText };
  return undefined;
}

/** An id that reads as what it annotates and does not collide — the same trade the canvas
 *  makes for edge ids: a timestamp would be unique and unreadable in a hand-editable file. */
export function annotationId(doc: AnnotationDoc, path: string): string {
  const base = `${path.split("/").pop()?.replace(/\.[^.]+$/, "") || "note"}-note`;
  const taken = new Set(doc.notes.map((note) => note.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface NewAnnotation {
  path: string;
  anchor: AnnotationAnchor;
  label: string;
  note: string;
  created?: string;
}

/** The whole document, for the first write — `fs.patch` cannot address a file that does
 *  not exist yet, so a fresh store is created with a plain write. */
export function seedAnnotations(doc: AnnotationDoc, entry: NewAnnotation): unknown {
  return { annotations: 1, notes: [entryValue(annotationId(doc, entry.path), entry)] };
}

function entryValue(id: string, entry: NewAnnotation): Record<string, unknown> {
  const anchor = serializeAnchor(entry.anchor);
  return {
    id,
    path: entry.path,
    ...(anchor ? { anchor } : {}),
    label: entry.label,
    note: entry.note.trim(),
    ...(entry.created ? { created: entry.created } : {}),
  };
}

export function addAnnotationOps(doc: AnnotationDoc, entry: NewAnnotation): PatchOp[] {
  if (!entry.note.trim()) return [];
  const value = entryValue(annotationId(doc, entry.path), entry);
  const insert: PatchOp = { op: "insert", path: ["notes"], index: doc.notes.length, value };
  // The file may exist without a `notes` key (hand-written, or emptied); the first note
  // has to create the key before it can insert into it.
  return doc.seeded ? [insert] : [{ op: "set", path: ["notes"], value: [] }, insert];
}

export function removeAnnotationOps(doc: AnnotationDoc, id: string): PatchOp[] {
  const note = doc.notes.find((candidate) => candidate.id === id);
  return note ? [{ op: "remove", path: ["notes", note.at] }] : [];
}

// ── The store, as a file session ─────────────────────────────────────────────

/** Read/write `annotations.yaml` for one open file. Structural edits go through
 *  `fs.patch` like every other machine edit here, so two people annotating different
 *  parts of the workspace do not overwrite each other and the file's comments survive. */
export function useAnnotations(fs: FsClient, path: string) {
  const session = useFileSession(fs, ANNOTATIONS_PATH);
  const doc = useMemo(() => parseAnnotations(session.data), [session.data]);
  const notes = useMemo(() => annotationsFor(doc, path), [doc, path]);

  const add = useCallback(
    async (entry: NewAnnotation) => {
      const stamped = { ...entry, created: entry.created ?? new Date().toISOString() };
      if (!stamped.note.trim()) return;
      // Nothing to patch INTO: the file does not exist, or it exists with no root
      // mapping (empty, or `null`). A key op needs an object to land in, so the first
      // note is a whole-document write. `setData` serializes into the buffer
      // synchronously, so the `save` below writes what was just seeded.
      if (session.version === null || !isObject(session.data)) {
        session.setData(seedAnnotations(doc, stamped));
        await session.save();
        return;
      }
      await session.applyOps(addAnnotationOps(doc, stamped));
    },
    [doc, session]
  );

  const remove = useCallback(
    async (id: string) => {
      if (session.version === null) return;
      await session.applyOps(removeAnnotationOps(doc, id));
    },
    [doc, session]
  );

  return { doc, notes, add, remove, status: session.status, text: session.parsedText };
}
