import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

// A centered modal shell: backdrop (click-to-close) + card (click-stop) + optional titled
// header with a close button. Reused by NewDmDialog, the bot-token modal, etc.
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
  onClose,
  children,
  maxWidth = "max-w-md",
  fullScreenOnMobile = false,
}: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
  fullScreenOnMobile?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24 max-md:items-end max-md:pt-0"
      onClick={onClose}
    >
      <div
        className={cn(
          // Borderless (DESIGN.md §2.4): the dimmed backdrop provides the separation.
          `w-full ${maxWidth} rounded-xl bg-zinc-900 p-4 space-y-3`,
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
            <span className="text-sm font-semibold text-zinc-100">{title}</span>
            <button
              onClick={onClose}
              title="Close"
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
