import { ActionButton } from "@/components/ui/action-button";
import { Button as UiButton } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Crosshair, MessageSquare, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Annotation, NewAnnotation } from "./annotations";
import { resolveAnnotation } from "./annotations";
import type { LensContextTarget } from "./lens/registry";

// The two halves of annotate, and neither of them is a strip in the body.
//
// A note is occasional: you write one now and then, and read them when you are looking
// for them. Anything permanently parked in the panel charges rent for both of those the
// whole time you are doing neither.

export interface PendingAnnotation {
  target: LensContextTarget;
  path: string;
  /** Where the right-click happened, so the composer opens on the thing it is about. */
  at: { x: number; y: number };
}

const COMPOSER_W = 320;
const COMPOSER_H = 168;
const EDGE = 8;

/** Compose one note, anchored at the click. Earlier this was a row in the panel's chrome,
 *  which put the box a long way from the row you had just right-clicked and pushed the
 *  content down to make room — you aimed at one place and typed in another. */
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
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  usePopoverDismiss(true, onCancel, rootRef);

  // A new target replaces whatever was half-written for the previous one: two notes
  // cannot be pending at once, so keeping the old draft would attach it to the wrong row.
  useEffect(() => {
    setNote("");
    inputRef.current?.focus();
  }, [pending]);

  // Clamped so the box is never half off-screen — a right-click near the bottom-right
  // corner of a panel is the normal case, not the edge case.
  const [box, setBox] = useState({ left: pending.at.x, top: pending.at.y });
  useLayoutEffect(() => {
    const maxLeft = window.innerWidth - COMPOSER_W - EDGE;
    const maxTop = window.innerHeight - COMPOSER_H - EDGE;
    setBox({
      left: Math.max(EDGE, Math.min(pending.at.x, maxLeft)),
      top: Math.max(EDGE, Math.min(pending.at.y + 8, maxTop)),
    });
  }, [pending]);

  const submit = () => {
    if (!note.trim()) return;
    onSubmit({ path: pending.path, anchor: anchorOfTarget(pending.target), label: pending.target.label, note });
  };

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`Note on ${pending.target.label}`}
      style={{ position: "fixed", left: box.left, top: box.top, width: COMPOSER_W }}
      className="z-50 flex flex-col gap-2 rounded-concentric [--concentric-inset:0.5rem] bg-panel p-3 elevation-overlay ring-1 ring-zinc-700"
    >
      <div className="flex items-center gap-2">
        <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-content-muted" aria-hidden="true" />
        <span className="min-w-0 truncate text-compact text-content-secondary">
          Note on <span className="text-content-primary">{pending.target.label}</span>
        </span>
      </div>
      <Textarea
        ref={inputRef}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter is a newline — the composer's convention, so a
          // one-line note (which is most of them) never needs the mouse.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="What should be said about this?"
        controlSize="regular"
        rows={3}
      />
      <div className="flex items-center justify-end gap-2">
        <UiButton action="cancel" variant="plain" onClick={onCancel} controlSize="regular" className="text-content-primary hover:text-content-strong">
          Cancel
        </UiButton>
        <ActionButton action="save" context="form" accessibleLabel="Save note" controlSize="regular" disabled={!note.trim()} onClick={submit} />
      </div>
    </div>,
    document.body
  );
}

function anchorOfTarget(target: LensContextTarget): NewAnnotation["anchor"] {
  if (target.sourcePath) return { kind: "path", sourcePath: target.sourcePath };
  if (target.sourceText !== undefined) return { kind: "text", sourceText: target.sourceText };
  return { kind: "file" };
}

/** The file's notes, behind one button in the panel's action corner. The count is on the
 *  button because that is the only thing you need to know without opening it: whether
 *  there is anything to read. */
export function AnnotationsButton({
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <IconButton
        label={notes.length === 0 ? "No notes on this file" : `${notes.length} note${notes.length > 1 ? "s" : ""} on this file`}
        aria-expanded={open}
        disabled={notes.length === 0}
        onClick={() => setOpen((current) => !current)}
        controlSize="compact"
      >
        <span className="relative inline-flex">
          <MessageSquare className="h-3.5 w-3.5" />
          {notes.length > 0 && (
            <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-sm bg-accent-400" aria-hidden="true" />
          )}
        </span>
      </IconButton>
      {open && (
        <PopoverPanel placement="down" align="end" className="w-80 p-2">
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {notes.map((note) => {
              const range = resolveAnnotation(note, text);
              return (
                <li key={note.id} className="flex items-center gap-2">
                  <span
                    className="flex-shrink-0 text-minimal text-content-muted"
                    title={range ? `lines ${range.start}-${range.end}` : "the anchor is no longer in this file"}
                  >
                    {/* An anchor that no longer resolves is shown as such: the note outlives
                        the row it was about, and pretending otherwise would point at a
                        stray line. */}
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
                      onClick={() => {
                        if (!range) return;
                        onReveal(range);
                        setOpen(false);
                      }}
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
        </PopoverPanel>
      )}
    </div>
  );
}
