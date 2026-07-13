import { useEffect, useRef } from "react";
import { Annotation, EditorState, StateEffect, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { tags as t } from "@lezer/highlight";

// A small, embeddable code editor for the workbench Raw mode. Like the <textarea> it
// replaces, it renders content as INERT TEXT (CodeMirror writes into DOM text nodes, never
// executes HTML), so stored file content still cannot XSS co-channel users. It only adds
// line numbers, undo history, bracket matching and per-language syntax highlighting on top.
//
// Kept intentionally lean: only markdown + json language packs are loaded (the formats the
// workspace actually carries); every other extension is a small core module, so the whole
// thing stays tree-shakeable and out of the main-bundle-size budget this repo guards.

// Theme matches the panel chrome: zinc-950 inset field, zinc-200 text, indigo focus ring
// (see frontend/DESIGN.md). Syntax colors are tinted "data-coding" hues — never chrome.
const theme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "#09090b", // zinc-950
      color: "#e4e4e7", // zinc-200
      fontSize: "12px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      lineHeight: "1.6",
    },
    ".cm-content": { padding: "12px 0", caretColor: "#a5b4fc" /* indigo-300 */ },
    ".cm-gutters": {
      backgroundColor: "#09090b",
      color: "#52525b", // zinc-600
      border: "none",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#a1a1aa" /* zinc-400 */ },
    ".cm-activeLine": { backgroundColor: "#18181b40" /* zinc-900/25 */ },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#a5b4fc" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#4f46e526", // indigo-600/15
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "#6366f133", // indigo-500/20
      outline: "none",
    },
  },
  { dark: true }
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#c4b5fd" }, // violet-300
  { tag: [t.string, t.special(t.string)], color: "#86efac" }, // green-300
  { tag: [t.number, t.bool, t.null, t.atom], color: "#fcd34d" }, // amber-300
  { tag: [t.propertyName], color: "#7dd3fc" }, // sky-300 (json keys)
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#71717a", fontStyle: "italic" }, // zinc-500
  { tag: [t.heading], color: "#e4e4e7", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#93c5fd", textDecoration: "underline" }, // blue-300
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.monospace], color: "#fda4af" }, // rose-300 (inline code)
  { tag: [t.punctuation, t.separator], color: "#a1a1aa" }, // zinc-400
  { tag: [t.invalid], color: "#f87171" }, // red-400
]);

// Language pack by extension. text/toml/xml fall through to no highlighting (plain text) —
// still a fully usable editor, just uncolored; add lang-* packs later if a format earns it.
function languageFor(path: string): Extension[] {
  const p = path.toLowerCase();
  if (p.endsWith(".json")) return [json()];
  if (p.endsWith(".md") || p.endsWith(".markdown")) return [markdown()];
  return [];
}

// Marks a dispatch as a programmatic content sync (not a user edit), so the updateListener
// can skip onChange for it — see the listener below.
const syncAnnotation = Annotation.define<boolean>();

function baseExtensions(path: string, onChange: (v: string) => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    syntaxHighlighting(highlight),
    theme,
    EditorView.lineWrapping,
    ...languageFor(path),
    EditorView.updateListener.of((u) => {
      // Only USER edits become dirty. Programmatic loads (path switch, live-push/conflict
      // reload) carry the `sync` annotation and must NOT call onChange — otherwise a clean
      // server reload marks the buffer dirty, wrongly enables Save, and blocks the next
      // live-push (FilePanel skips reloads when it thinks there are unsaved edits).
      if (!u.docChanged) return;
      if (u.transactions.some((tr) => tr.annotation(syncAnnotation))) return;
      onChange(u.state.doc.toString());
    }),
  ];
}

interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  path: string;
  className?: string;
}

// Uncontrolled-with-sync: CodeMirror owns the document, we push external changes in only
// when they differ from what the editor already holds (path switch, live-push reload). This
// keeps the cursor/selection intact while typing — our own edits round-trip back as `value`
// equal to the doc, so the sync effect no-ops. onChange/path changes rebuild only the tiny
// bits that depend on them, not the whole view.
export function CodeEditor({ value, onChange, path, className }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest callback/path read through refs so the EditorView is built ONCE (not torn down
  // and recreated on every render), yet always dispatches to the current onChange.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pathRef = useRef(path);

  // Build the view once on mount.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: baseExtensions(pathRef.current, (v) => onChangeRef.current(v)),
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure language when the file (path) changes, and reset the doc to the new file's
  // content in the same shot — a path switch always brings a fresh buffer from the hook.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pathRef.current === path) return;
    pathRef.current = path;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      effects: StateEffect.reconfigure.of(baseExtensions(path, (v) => onChangeRef.current(v))),
      annotations: syncAnnotation.of(true),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, value]);

  // Sync external content changes (live-push reload, conflict reload) without clobbering the
  // cursor: only replace the doc when the incoming value truly differs from the editor's.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pathRef.current !== path) return; // path effect above handles path switches
    if (value === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: syncAnnotation.of(true),
    });
  }, [value, path]);

  return <div ref={hostRef} className={className} />;
}
