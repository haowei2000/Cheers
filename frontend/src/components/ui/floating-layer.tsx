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
type Align = "start" | "center" | "end";

/**
 * Renders a transient surface in the document body instead of inside its
 * trigger. This is deliberately the single escape hatch for menus, hover
 * actions and help bubbles: a scrolling or rounded parent must never crop a
 * control that has floated outside it.
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
      setStyle({
        position: "fixed",
        top: placement === "up" ? rect.top - 8 : rect.bottom + 8,
        left: align === "start" ? rect.left : align === "end" ? rect.right : rect.left + rect.width / 2,
        transform: `${placement === "up" ? "translateY(-100%)" : ""}${align === "end" ? " translateX(-100%)" : align === "center" ? " translateX(-50%)" : ""}`,
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
