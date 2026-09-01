import { ActionButton } from "@/components/ui/action-button";
import { Button as UiButton } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Textarea } from "@/components/ui/textarea";
import { Crosshair, MessageSquare, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Annotation, NewAnnotation } from "./annotations";
import { resolveAnnotation } from "./annotations";
import type { LensContextTarget } from "./lens/registry";

// The host side of annotate: where a note is composed, and where the file's existing
// notes are visible.
//
// It lives in the host's chrome rather than in a popover at the click, because a note is
// composed against the thing you are looking at — a floating box over the row you are
// annotating hides exactly what you are writing about.

export interface PendingAnnotation {
  target: LensContextTarget;
  path: string;
}

/** Compose one note. Rendered only while a target is pending, so the panel costs nothing
 *  until someone actually annotates. */
export function AnnotationComposer({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: PendingAnnotation;
  onSubmit: (entry: NewAnnotation) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // A new target replaces whatever was half-written for the previous one: two notes
  // cannot be pending at once, so keeping the old draft would attach it to the wrong row.
  useEffect(() => {
    setNote("");
    inputRef.current?.focus();
  }, [pending]);

  const submit = () => {
    if (!note.trim()) return;
    onSubmit({
      path: pending.path,
      anchor: anchorOfTarget(pending.target),
      label: pending.target.label,
      note,
    });
  };

  return (
    <div className="mx-1 mt-1 flex flex-shrink-0 flex-col gap-2 rounded-sm bg-zinc-900/50 px-3 py-2">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-content-muted" />
        <span className="min-w-0 truncate text-compact text-content-secondary">
          Note on <span className="text-content-primary">{pending.target.label}</span>
        </span>
      </div>
      <Textarea
        ref={inputRef}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is a newline — the composer's own convention, so a
          // one-line note (which is most of them) never needs the mouse.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") onCancel();
        }}
        placeholder="What should be said about this? (Enter to save, Shift+Enter for a new line)"
        controlSize="regular"
        rows={2}
      />
      <div className="flex items-center justify-end gap-2">
        <UiButton action="cancel" variant="plain" onClick={onCancel} controlSize="regular" className="text-content-primary hover:text-content-strong">
          Cancel
        </UiButton>
        <ActionButton action="save" context="form" accessibleLabel="Save note" controlSize="regular" disabled={!note.trim()} onClick={submit} />
      </div>
    </div>
  );
}

function anchorOfTarget(target: LensContextTarget): NewAnnotation["anchor"] {
  if (target.sourcePath) return { kind: "path", sourcePath: target.sourcePath };
  if (target.sourceText !== undefined) return { kind: "text", sourceText: target.sourceText };
  return { kind: "file" };
}

/** The notes on the open file. Without this a note would be invisible unless you
 *  right-clicked the exact row that carries it — which is only findable if you already
 *  knew it was there. */
export function AnnotationList({
  notes,
  text,
  onRemove,
  onReveal,
}: {
  notes: readonly Annotation[];
  /** The file's current text, for resolving each anchor to where it now points. */
  text: string;
  onRemove: (id: string) => void;
  onReveal?: (range: { start: number; end: number }) => void;
}) {
  if (notes.length === 0) return null;
  return (
    <ul className="mx-1 mb-1 flex max-h-32 flex-shrink-0 flex-col gap-1 overflow-y-auto rounded-sm bg-zinc-900/50 px-3 py-2">
      {notes.map((note) => {
        const range = resolveAnnotation(note, text);
        return (
          <li key={note.id} className="flex items-center gap-2">
            <span
              className="flex-shrink-0 text-minimal text-content-muted"
              title={range ? `lines ${range.start}-${range.end}` : "the anchor is no longer in this file"}
            >
              {/* An anchor that no longer resolves is shown as such: the note outlives the
                  row it was about, and pretending otherwise would point at a stray line. */}
              {range ? `L${range.start}` : "—"}
            </span>
            <span className="min-w-0 flex-1 truncate text-compact text-content-secondary" title={note.note}>
              <span className="text-content-muted">{note.label}: </span>
              {note.note}
            </span>
            {onReveal && (
              <IconButton
                label={range ? `Show lines ${range.start}-${range.end}` : `${note.label} is no longer in this file`}
                disabled={!range}
                onClick={() => range && onReveal(range)}
                controlSize="compact"
              >
                <Crosshair className="h-3.5 w-3.5" />
              </IconButton>
            )}
            <IconButton label={`Remove note on ${note.label}`} onClick={() => onRemove(note.id)} controlSize="compact">
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}
