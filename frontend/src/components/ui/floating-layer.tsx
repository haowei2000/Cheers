import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

type Placement = "up" | "down";
export type AnchorPlacement = Placement | "left" | "right";
type Align = "start" | "center" | "end";

const GAP = 8;
/** Flip away from the preferred side once the room there drops below this. */
const MIN_COMFORTABLE = 240;

/**
 * Pick the side that keeps the surface on-screen. Honors the caller's preferred
 * placement when both sides are ample; otherwise opens toward the roomier side.
 */
function resolvePlacement(
  preferred: Placement,
  spaceAbove: number,
  spaceBelow: number,
): Placement {
  if (preferred === "down") {
    return spaceBelow < MIN_COMFORTABLE && spaceAbove > spaceBelow ? "up" : "down";
  }
  return spaceAbove < MIN_COMFORTABLE && spaceBelow > spaceAbove ? "down" : "up";
}

/**
 * Renders a transient surface in the document body instead of inside its
 * trigger. This is deliberately the single escape hatch for menus, hover
 * actions and help bubbles: a scrolling or rounded-sm parent must never crop a
 * control that has floated outside it.
 *
 * Placement flips when the preferred side is cramped (e.g. a trace inspector
 * opened on a row near the composer), and `maxHeight` is clamped to the
 * remaining viewport so the panel scrolls instead of spilling off-screen.
 */
export function FloatingLayer({
  anchorRef,
  placement = "down",
  align = "start",
  className,
  children,
  id,
  role,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  align?: Align;
  className?: string;
  children: ReactNode;
  id?: string;
  role?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;

      const spaceBelow = window.innerHeight - rect.bottom - GAP;
      const spaceAbove = rect.top - GAP;
      const resolved = resolvePlacement(placement, spaceAbove, spaceBelow);
      const available = Math.max(0, resolved === "down" ? spaceBelow : spaceAbove);

      setStyle({
        position: "fixed",
        top: resolved === "up" ? rect.top - GAP : rect.bottom + GAP,
        left:
          align === "start"
            ? rect.left
            : align === "end"
              ? rect.right
              : rect.left + rect.width / 2,
        transform: `${resolved === "up" ? "translateY(-100%)" : ""}${
          align === "end" ? " translateX(-100%)" : align === "center" ? " translateX(-50%)" : ""
        }`,
        // Inline clamp beats a looser Tailwind max-h so a near-edge open still fits.
        ...(available > 0 ? { maxHeight: available } : {}),
      });
    };

    update();
    window.addEventListener("resize", update);
    // Capture scrolls from any nested scroller, not just the document.
    window.addEventListener("scroll", update, true);
    const observer = new ResizeObserver(update);
    if (anchorRef.current) observer.observe(anchorRef.current);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer.disconnect();
    };
  }, [align, anchorRef, placement]);

  if (!style) return null;
  return createPortal(
    <div
      id={id}
      role={role}
      style={style}
      // Outside-dismiss handlers live on document. Keep interactions inside a
      // portalled menu from being mistaken for an outside press.
      onMouseDown={(event) => event.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      className={cn("z-[100]", className)}
    >
      {children}
    </div>,
    document.body
  );
}

/**
 * Viewport top-left for a free-floating panel near an anchor. Flips above when
 * the preferred side is cramped; clamps so a grabbable sliver stays on-screen.
 */
function placeNearRect(
  anchor: DOMRect,
  panelW: number,
  panelH: number,
  preferred: AnchorPlacement = "down",
  viewport: { width: number; height: number } = {
    width: typeof window !== "undefined" ? window.innerWidth : 0,
    height: typeof window !== "undefined" ? window.innerHeight : 0,
  },
): { x: number; y: number } {
  const horizontal = preferred === "left" || preferred === "right";
  const spaceBelow = viewport.height - anchor.bottom - GAP;
  const spaceAbove = anchor.top - GAP;
  const spaceLeft = anchor.left - GAP;
  const spaceRight = viewport.width - anchor.right - GAP;
  const side: AnchorPlacement = horizontal
    ? preferred === "left"
      ? spaceLeft < panelW && spaceRight > spaceLeft ? "right" : "left"
      : spaceRight < panelW && spaceLeft > spaceRight ? "left" : "right"
    : resolvePlacement(preferred, spaceAbove, spaceBelow);
  const rawY = side === "down"
    ? anchor.bottom + GAP
    : side === "up"
      ? anchor.top - GAP - panelH
      : anchor.top;
  const rawX = side === "left"
    ? anchor.left - GAP - panelW
    : side === "right"
      ? anchor.right + GAP
      : anchor.left;
  const maxX = Math.max(GAP, viewport.width - Math.min(panelW, viewport.width - GAP * 2) - GAP);
  const maxY = Math.max(GAP, viewport.height - Math.min(panelH, viewport.height - GAP * 2) - GAP);
  return {
    x: Math.round(Math.min(Math.max(GAP, rawX), maxX)),
    y: Math.round(Math.min(Math.max(GAP, rawY), maxY)),
  };
}

/** Exported for unit tests and viewport-float callers. */
export { resolvePlacement, placeNearRect };
