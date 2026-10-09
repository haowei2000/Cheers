import { useCallback, useMemo } from "react";
import { useChannelAnnotations } from "@/features/annotations/useAnnotations";
import { inspectableIdLineRange, sourcePathLineRange, uniqueSourceTextRange, type SourceLineRange } from "./contextSource";
import type { LensContextTarget } from "./lens/registry";
import { parseLocator } from "../locator";

// File-anchor adapter for workspace renderers. File and event annotations are
// persisted by the shared channel API; annotations.yaml is imported by the gateway.

export type { AnnotationAnchor } from "@/features/annotations/types";
import type { AnnotationAnchor } from "@/features/annotations/types";

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
  if (typeof raw.uri === "string") {
    const locator = parseLocator(raw.uri);
    if (locator?.kind === "desk" && locator.inspectableId) return { kind: "uri", uri: raw.uri };
  }
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
  if (target.inspectableId && target.locator) return { kind: "uri", uri: target.locator };
  if (target.sourcePath) return { kind: "path", sourcePath: target.sourcePath };
  if (target.sourceText !== undefined) return { kind: "text", sourceText: target.sourceText };
  return { kind: "file" };
}

/** Two anchors name the same part of a document. Used to show a target's existing notes
 *  in the same menu that creates them. */
export function sameAnchor(a: AnnotationAnchor, b: AnnotationAnchor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "uri" && b.kind === "uri") return a.uri === b.uri;
  if (a.kind === "path" && b.kind === "path") {
    return a.sourcePath.length === b.sourcePath.length &&
      a.sourcePath.every((part, index) => part === b.sourcePath[index]);
  }
  if (a.kind === "text" && b.kind === "text") return a.sourceText === b.sourceText;
  return true;
}

export function sourcePathKey(path: ReadonlyArray<string | number>): string {
  return JSON.stringify(path);
}

export function anchorKey(anchor: AnnotationAnchor): string {
  if (anchor.kind === "uri") return `uri:${anchor.uri}`;
  if (anchor.kind === "path") return sourcePathKey(anchor.sourcePath);
  if (anchor.kind === "text") return `text:${anchor.sourceText}`;
  return "file";
}

export function notesOnTarget(doc: AnnotationDoc, path: string, target: LensContextTarget): Annotation[] {
  const anchor = anchorOf(target);
  return annotationsFor(doc, path).filter((note) => sameAnchor(note.anchor, anchor));
}

/** Where the note points, in the CURRENT text. Null when the anchor no longer resolves —
 *  the row was deleted, the prose rewritten — which is a fact worth showing, not an error
 *  to swallow: the note is still there, it just no longer has a place to sit. */
export function resolveAnnotation(note: Annotation, text: string): SourceLineRange | null {
  if (note.anchor.kind === "uri") {
    const locator = parseLocator(note.anchor.uri);
    return locator?.kind === "desk" && locator.path === note.path && locator.inspectableId
      ? inspectableIdLineRange(text, locator.inspectableId)
      : null;
  }
  if (note.anchor.kind === "path") return sourcePathLineRange(text, note.anchor.sourcePath);
  if (note.anchor.kind === "text") return uniqueSourceTextRange(text, note.anchor.sourceText);
  return null;
}

export interface NewAnnotation {
  path: string;
  anchor: AnnotationAnchor;
  label: string;
  note: string;
  created?: string;
}

// The YAML file is a legacy import source. All new file and event notes share
// gateway persistence; soft-deleted imported ids can never be resurrected.
export function useAnnotations(path: string, channelId: string) {
  const store = useChannelAnnotations(channelId);
  const { notes: storedNotes, add: addAnnotation, remove: removeAnnotation } = store;
  const doc: AnnotationDoc = useMemo(() => ({ seeded: true, notes: storedNotes.flatMap((item, at) => item.target.kind === "file" ? [{
    id: item.id, at, path: item.target.path, anchor: item.target.anchor, label: item.label, note: item.note, created: item.created_at,
  }] : []) }), [storedNotes]);
  const notes = useMemo(() => annotationsFor(doc, path), [doc, path]);
  const add = useCallback(async (entry: NewAnnotation) => {
    await addAnnotation({ target: { kind: "file", path: entry.path, anchor: entry.anchor }, label: entry.label, note: entry.note });
  }, [addAnnotation]);
  const remove = useCallback(async (id: string) => {
    const item = storedNotes.find(n => n.id === id);
    if (item) await removeAnnotation(item);
  }, [storedNotes, removeAnnotation]);
  return { doc, notes, add, remove, status: store.error?.message ?? (store.isLoading ? "Loading annotations…" : "") };
}
