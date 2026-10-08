import { ActionButton } from "@/components/ui/action-button";
import { Button as UiButton } from "@/components/ui/button";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import { usePopoverDismiss } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { disarmHover } from "@/lib/hoverIntent";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NewAnnotation } from "./annotations";
import type { LensContextTarget } from "./lens/registry";

export interface PendingAnnotation {
  target: LensContextTarget;
  path: string;
  /** Where the right-click happened, so the composer opens on the thing it is about. */
  at: { x: number; y: number };
}

export interface AnnotationComposerProps {
  pending: PendingAnnotation;
  onSubmit: (entry: NewAnnotation) => void | Promise<void>;
  onCancel: () => void;
}

const COMPOSER_W = 320;
const COMPOSER_H = 168;
const EDGE = 8;

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function anchorOfTarget(
  target: LensContextTarget,
): NewAnnotation["anchor"] {
  if (target.inspectableId && target.locator)
    return { kind: "uri", uri: target.locator };
  if (target.sourcePath) return { kind: "path", sourcePath: target.sourcePath };
  if (target.sourceText !== undefined)
    return { kind: "text", sourceText: target.sourceText };
  return { kind: "file" };
}

/**
 * Compose one note, anchored at the click.
 *
 * Earlier this was a row in the panel's chrome, which put the box a long way
 * from the row you had just right-clicked and pushed the content down to make room.
 *
 * Accessibility & Interaction (HIG & Cheers contract):
 * - Role: dialog (aria-modal="true") with accessible label identifying the target.
 * - Focus management: captures previous focus on mount and restores it on dismiss.
 * - Keyboard navigation: Esc to cancel, Ctrl/Cmd+Enter to save, Tab focus trapping.
 * - Tokens: concentric corners, bg-panel, elevation-overlay, ring-1 ring-control/40 for crisp contrast.
 */
export function AnnotationComposer({
  pending,
  onSubmit,
  onCancel,
}: AnnotationComposerProps) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Dismiss on outside click or global Escape
  usePopoverDismiss(!saving, onCancel, rootRef);

  // Capture previous focused element before mount to restore on dismiss
  const [previouslyFocused] = useState(() =>
    typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null,
  );

  // A new target replaces whatever was half-written for the previous one: two notes
  // cannot be pending at once, so keeping the old draft would attach it to the wrong row.
  useEffect(() => {
    setNote("");
    inputRef.current?.focus();
  }, [pending]);

  // Tab trapping and keyboard handling inside the composer dialog
  useEffect(() => {
    disarmHover();
    const root = rootRef.current;
    if (!root) return;

    const getFocusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (!savingRef.current) onCancelRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const items = getFocusables();
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement;

      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    root.addEventListener("keydown", onKeyDown);
    return () => {
      disarmHover();
      root.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [previouslyFocused]);

  // Clamped so the box is never half off-screen — a right-click near the bottom-right
  // corner of a panel is the normal case, not the edge case.
  const [box, setBox] = useState({ left: pending.at.x, top: pending.at.y });
  useIsomorphicLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const maxLeft = window.innerWidth - COMPOSER_W - EDGE;
    const maxTop = window.innerHeight - COMPOSER_H - EDGE;
    setBox({
      left: Math.max(EDGE, Math.min(pending.at.x, maxLeft)),
      top: Math.max(EDGE, Math.min(pending.at.y + 8, maxTop)),
    });
  }, [pending]);

  const submit = async () => {
    if (!note.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        path: pending.path,
        anchor: anchorOfTarget(pending.target),
        label: pending.target.label,
        note,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save note. Retry.");
    } finally {
      setSaving(false);
    }
  };

  const content = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Note on ${pending.target.label}`}
      tabIndex={-1}
      style={{
        position: "fixed",
        left: box.left,
        top: box.top,
        width: COMPOSER_W,
      }}
      className="z-50 flex flex-col gap-2 rounded-concentric [--concentric-inset:0.5rem] bg-panel p-3 elevation-overlay ring-1 ring-control/40 outline-none"
    >
      <div className="flex items-center gap-2">
        <EditorialIcon
          name="annotation"
          contentSize="small"
          className="shrink-0 text-content-muted"
        />
        <span className="min-w-0 truncate text-compact text-content-secondary">
          Note on{" "}
          <span className="font-medium text-content-primary">
            {pending.target.label}
          </span>
        </span>
      </div>
      <Textarea
        ref={inputRef}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!savingRef.current) onCancelRef.current();
          } else if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="What should be said about this?"
        controlSize="regular"
        rows={3}
        disabled={saving}
        maxLength={16384}
        aria-label="Annotation note content"
      />
      {error && (
        <p role="alert" className="text-regular text-danger-400">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <UiButton
          action="cancel"
          variant="plain"
          onClick={onCancel}
          disabled={saving}
          controlSize="regular"
          className="text-content-primary hover:text-content-strong"
        >
          Cancel
        </UiButton>
        <ActionButton
          action="save"
          context="form"
          accessibleLabel="Save note"
          controlSize="regular"
          disabled={!note.trim() || saving}
          onClick={submit}
        />
      </div>
    </div>
  );

  if (typeof document === "undefined") {
    return content;
  }

  return createPortal(content, document.body);
}
