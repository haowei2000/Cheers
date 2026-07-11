import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

// A centered modal shell: backdrop (click-to-close) + card (click-stop) + optional titled
// header with a close button. Reused by NewDmDialog, the bot-token modal, etc.
//
// Accessibility (HIG modality floor — see .claude/skills/apple-hig-review):
//  - Esc dismisses. The card is role="dialog" aria-modal, named by its title (or an
//    explicit `ariaLabel` when title is omitted) so screen readers announce it.
//  - Focus is trapped inside while open and returned to the invoking element on close,
//    so keyboard and screen-reader users can't wander into the inert background.
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
}: {
  title?: ReactNode;
  // Accessible name when no visible `title` is rendered (e.g. media/preview modals).
  ariaLabel?: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
  fullScreenOnMobile?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Latest onClose without making the focus/key effect re-run (and steal focus) on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Capture the element that opened us at RENDER time — before commit applies any
  // autoFocus inside the dialog. A useEffect would run too late and capture the
  // dialog's own autoFocus'd input, so closing would refocus a removed node (→ body).
  const [previouslyFocused] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
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
      card.removeEventListener("keydown", onKeyDown);
      // Return focus to whatever opened the dialog, so keyboard users resume in place.
      // Guard isConnected so a since-unmounted trigger doesn't throw / strand focus.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [previouslyFocused]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24 max-md:items-end max-md:pt-0"
      onClick={onClose}
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
          `w-full ${maxWidth} rounded-xl bg-zinc-900 p-4 space-y-3 outline-none`,
          "max-h-[calc(100dvh-7rem)] overflow-y-auto overscroll-contain",
          "max-md:max-w-none max-md:rounded-b-none max-md:pb-[max(1rem,env(safe-area-inset-bottom))]",
          fullScreenOnMobile
            ? "max-md:h-full max-md:max-h-none max-md:rounded-none max-md:flex max-md:flex-col max-md:overflow-hidden max-md:pt-[max(1rem,env(safe-area-inset-top))]"
            : "max-md:max-h-[92dvh]"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="flex items-center gap-2 max-md:flex-shrink-0">
            <h2 id={titleId} className="text-sm font-semibold text-zinc-100">
              {title}
            </h2>
            <button
              onClick={onClose}
              title="Close"
              aria-label="Close"
              className="ml-auto text-zinc-500 hover:text-zinc-300 max-md:p-2 max-md:-m-2"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
