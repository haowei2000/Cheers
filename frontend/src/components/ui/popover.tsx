// Anchored-popover primitive (DESIGN.md §2.4). Codifies the hand-rolled pattern
// used across the app: a `relative` anchor wrapping a trigger + an absolutely
// positioned borderless panel, dismissed by outside-mousedown or Escape.
//
// Usage:
//   const rootRef = useRef<HTMLDivElement>(null);
//   usePopoverDismiss(open, close, rootRef);
//   <div ref={rootRef} className="relative inline-flex">
//     <button aria-expanded={open} …>trigger</button>
//     {open && <PopoverPanel placement="up">…</PopoverPanel>}
//   </div>
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { FloatingLayer } from "./floating-layer";

/**
 * Close an open popover on outside mousedown or Escape. Outside-ness is checked
 * with `rootRef.contains`, so keep the trigger inside the root — the toggle then
 * never close-then-reopens. Escape is claimed (`preventDefault`) so outer Esc
 * handlers (reply/selection cancel in ChannelView) skip an Esc meant for us.
 */
export function usePopoverDismiss(
  open: boolean,
  onClose: () => void,
  rootRef: RefObject<HTMLElement | null>
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, rootRef]);
}

/**
 * The floating surface itself. Its marker stays in the relative anchor, while
 * the visible panel is portalled to the document body so it cannot be clipped
 * by a scrolling, rounded, or transformed parent. Width/padding stay with the
 * caller.
 */
export function PopoverPanel({
  placement = "up",
  align = "start",
  className,
  children,
}: {
  /** "up" opens above the anchor (composer controls), "down" below (headers). */
  placement?: "up" | "down";
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span ref={anchorRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      <FloatingLayer
        anchorRef={anchorRef}
        placement={placement}
        align={align}
        className={cn("rounded-xl bg-zinc-900 shadow-xl shadow-black/40", className)}
      >
        {children}
      </FloatingLayer>
    </>
  );
}
