import { ButtonGroup } from "./button-group";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { ActionButton } from "./action-button";
import { disarmHover } from "@/lib/hoverIntent";
import { Button } from "./button";

const DialogCloseContext = createContext<(() => void) | null>(null);
/** Nested detail headers must use the same guarded close as dialog chrome. */
export const useDialogClose = () => useContext(DialogCloseContext);

// A centered modal shell: backdrop (click-to-close) + card (click-stop) + optional titled
// header with a close button. Reused by NewDmDialog, the bot-token modal, etc.
//
// Accessibility (HIG modality floor — see .claude/skills/apple-hig-review):
//  - Esc dismisses. The card is role="dialog" aria-modal, named by its title (or an
//    explicit `ariaLabel` when title is omitted) so screen readers announce it.
//  - Focus is trapped inside while open and returned to the invoking element on close,
//    so keyboard and screen-reader users can't wander into the inert background.
//
// Portal: always mount on document.body. Settings / Friends / similar pages scroll
// inside an overflow-y-auto ancestor that also sets -webkit-overflow-scrolling:touch;
// in WKWebView (Tauri desktop) that makes position:fixed resolve against the scroller,
// so a Dialog rendered in-tree opens off-screen after you've scrolled — the delete
// confirm on Connector looked like a dead button. Portalling matches DESIGN.md §2.4
// ("escape a transform/overflow ancestor → portal to document.body").
//
// Responsive behavior:
//  - Desktop (>= md): unchanged look — top-aligned centered card. The card additionally
//    caps its height at the viewport and scrolls internally, so tall content is never
//    clipped by the fixed backdrop.
//  - Mobile (< md): the card becomes a bottom sheet (full width, capped height, internal
//    scroll, safe-area bottom padding). With `fullScreenOnMobile` it instead covers the
//    whole screen as a flex column — used by heavy panels (e.g. the remote workspace /
//    git review UI) whose children stretch with `max-md:flex-1`.
export function Dialog({
  title,
  ariaLabel,
  onClose,
  children,
  maxWidth = "max-w-md",
  fullScreenOnMobile = false,
  dirty = false,
  busy = false,
}: {
  title?: ReactNode;
  // Accessible name when no visible `title` is rendered (e.g. media/preview modals).
  ariaLabel?: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
  fullScreenOnMobile?: boolean;
  /** Preserve unfinished form input when closing via chrome, backdrop, or Escape. */
  dirty?: boolean;
  busy?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Latest onClose without making the focus/key effect re-run (and steal focus) on every render.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const discardReturnRef = useRef<HTMLElement | null>(null);
  const keepEditing = () => {
    setConfirmDiscard(false);
    if (discardReturnRef.current?.isConnected) discardReturnRef.current.focus();
  };
  const requestClose = () => {
    if (busy) return;
    if (confirmDiscard) { keepEditing(); return; }
    if (dirty) {
      discardReturnRef.current = document.activeElement as HTMLElement | null;
      setConfirmDiscard(true);
    }
    else onClose();
  };
  const onCloseRef = useRef(requestClose);
  onCloseRef.current = requestClose;
  useEffect(() => { if (confirmDiscard) keepEditingRef.current?.focus(); }, [confirmDiscard]);
  useEffect(() => { if (!dirty) setConfirmDiscard(false); }, [dirty]);
  // Capture the element that opened us at RENDER time — before commit applies any
  // autoFocus inside the dialog. A useEffect would run too late and capture the
  // dialog's own autoFocus'd input, so closing would refocus a removed node (→ body).
  const [previouslyFocused] = useState(() =>
    typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null
  );

  useEffect(() => {
    disarmHover();
    const card = cardRef.current;
    if (!card) return;

    const focusables = () =>
      Array.from(
        card.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Move focus into the dialog so the very next Tab stays inside and screen readers
    // land on the dialog content rather than the background page — but only if the
    // caller hasn't already placed focus inside (e.g. an autoFocus'd search/name input),
    // otherwise we'd yank focus off it onto the Close button.
    if (!card.contains(document.activeElement)) (focusables()[0] ?? card).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || !card.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    card.addEventListener("keydown", onKeyDown);
    return () => {
      disarmHover();
      card.removeEventListener("keydown", onKeyDown);
      // Return focus to whatever opened the dialog, so keyboard users resume in place.
      // Guard isConnected so a since-unmounted trigger doesn't throw / strand focus.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [previouslyFocused]);

  const content = (
    <DialogCloseContext.Provider value={requestClose}>
    <div
      className="fixed inset-0 z-100 flex items-start justify-center bg-black/50 pt-24 max-md:items-end max-md:pt-0"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === "Escape") requestClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        aria-label={title === undefined ? ariaLabel : undefined}
        tabIndex={-1}
        className={cn(
          // Borderless (DESIGN.md §2.4): the dimmed backdrop provides the separation.
          `w-full ${maxWidth} rounded-concentric [--concentric-inset:1rem] bg-panel elevation-overlay outline-none flex flex-col`,
          "max-h-[calc(100dvh-7rem)] overflow-hidden",
          "max-md:max-w-none max-md:rounded-b-none",
          fullScreenOnMobile
            ? "max-md:h-full max-md:max-h-none max-md:rounded-none max-md:pt-[max(1rem,env(safe-area-inset-top))]"
            : "max-md:max-h-[92dvh]"
        )}
      >
        {title !== undefined && (
          <div className="flex items-center gap-2 shrink-0 px-4 pt-4 pb-3 max-md:shrink-0">
            <h2 id={titleId} className="min-w-0 flex-1 text-regular font-semibold text-content-primary">
              {title}
            </h2>
            <ButtonGroup label="Dialog controls" className="ml-auto shrink-0">
              <ActionButton
                action="close"
                context="windowChrome"
                onClick={requestClose}
                disabled={busy}
                accessibleLabel="Close dialog"
                controlSize="compact"
                className="text-content-primary hover:text-content-strong"
              />
            </ButtonGroup>
          </div>
        )}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-3",
            title === undefined && "pt-4",
            "max-md:pb-[max(1rem,env(safe-area-inset-bottom))]",
          )}
        >
          {confirmDiscard && <div role="alert" className="space-y-2 rounded-sm bg-control p-3">
            <p className="font-utility text-regular text-content-primary">Discard your unsaved changes?</p>
            <div className="flex flex-wrap gap-2">
              <Button ref={keepEditingRef} action="cancel" variant="secondary" disabled={busy} onClick={keepEditing} aria-label="Keep editing" />
              <Button action="discard" variant="danger" disabled={busy} onClick={onClose} />
            </div>
          </div>}
          {children}
        </div>
      </div>
    </div>
    </DialogCloseContext.Provider>
  );

  if (typeof document === "undefined") {
    return content;
  }

  return createPortal(content, document.body);
}
