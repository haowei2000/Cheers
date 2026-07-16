import { parseDocument, stringify as yamlStringify, visit, type Document } from "yaml";

// Comment-preserving YAML rewrite. The workbench machine-rewrites board files (lenses
// save whole documents), and a naive parse -> stringify would eat every comment — the
// exact failure that forced `.workbench.json`'s `_doc` field. So instead of
// re-serializing, we PATCH the parsed Document (a CST that carries comments and blank
// lines) with a deep diff of old vs new data, and only the changed nodes are touched.
//
// Documented loss cases (correctness always wins over comment retention):
// - unparseable input, MULTI-document streams, and anchors/aliases fall back to a full
//   re-stringify (patching through an alias would silently edit the anchor's other
//   readers — bailing is safer);
// - an array whose LENGTH changed is replaced wholesale, so comments attached inside
//   that array are lost (per-index diffing can't tell an insert from N edits). A
//   SAME-length reorder is NOT detected — it is patched per index, so item comments
//   keep their old positions and can end up annotating different items.

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

type Path = (string | number)[];

function diffApply(doc: Document, path: Path, prev: unknown, next: unknown): void {
  if (Object.is(prev, next)) return;
  if (isPlainObj(prev) && isPlainObj(next)) {
    for (const k of Object.keys(prev)) if (!(k in next)) doc.deleteIn([...path, k]);
    for (const k of Object.keys(next)) {
      if (!(k in prev)) doc.setIn([...path, k], next[k]);
      else diffApply(doc, [...path, k], prev[k], next[k]);
    }
    return;
  }
  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length) {
    for (let i = 0; i < next.length; i++) diffApply(doc, [...path, i], prev[i], next[i]);
    return;
  }
  // Scalar change, type change, or array resize: replace this node wholesale.
  if (path.length === 0) doc.contents = doc.createNode(next) as never;
  else doc.setIn(path, next);
}

/** Serialize `next` by patching the Document parsed from `prevText`, preserving the
 *  comments and blank lines of everything that didn't change. */
export function applyEdits(prevText: string, next: unknown): string {
  if (!prevText.trim()) return yamlStringify(next);
  // parseDocument, not parseAllDocuments: for a COMMENT-ONLY file the all-documents
  // parser returns zero docs (forcing the lossy stringify fallback, eating a seeded
  // "# fill me in" header on the first save), while parseDocument yields one document
  // with null contents whose comments live on doc.commentBefore/doc.comment — those
  // sit outside `contents` and so survive the wholesale root replacement below. A
  // multi-doc stream surfaces as a MULTIPLE_DOCS error and bails like before.
  const doc = parseDocument(prevText);
  if (doc.errors.length > 0) return yamlStringify(next); // unparseable or multi-doc: bail (lossy)
  let hasAlias = false;
  visit(doc, {
    Alias: () => {
      hasAlias = true;
      return visit.BREAK;
    },
  });
  if (hasAlias) return yamlStringify(next); // aliases: bail (see header)
  diffApply(doc, [], doc.toJS() as unknown, next);
  // lineWidth 0 = never refold long plain scalars the diff didn't touch — the default
  // (80) reflows them whenever ANYTHING else is edited, polluting git/bot-watched diffs.
  return doc.toString({ lineWidth: 0 });
}
