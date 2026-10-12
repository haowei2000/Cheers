import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type MouseEvent, type KeyboardEvent, type FocusEvent } from "react";
import { cn } from "@/lib/cn";
import { FloatingLayer } from "./floating-layer";
import { contrastTooltipSurfaceClasses } from "./tooltip-surface";
import { isPointerFocus, markPointerInteraction, onDisarmHover, whenPointerRests } from "@/lib/hoverIntent";

/** Help belongs to existing text or controls. Never put required errors or
 * irreversible consequences here; those remain inline or in confirmation. */
export function Tip({ content, children, align = "center", label = "More information", className, textTrigger = false }: {
  content: ReactNode;
  children?: ReactElement;
  align?: "start" | "center" | "end";
  /** Visible text when no child is supplied. */
  label?: string;
  className?: string;
  /** Text opens on tap/Enter; wrapped action controls keep their own action. */
  textTrigger?: boolean;
}) {
  const isTextTrigger = textTrigger || !children;
  const id = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const cancelRest = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);

  const closeTip = useCallback(() => {
    cancelRest.current?.();
    cancelRest.current = null;
    pinned.current = false;
    setOpen(false);
  }, []);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeTip();
    };
    const unsubscribe = onDisarmHover(closeTip);
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", closeTip);
    return () => {
      unsubscribe();
      cancelRest.current?.();
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", closeTip);
    };
  }, [closeTip]);

  const child = children as ReactElement<{ "aria-describedby"?: string; title?: string }> | undefined;
  const trigger = child && isValidElement(child)
    ? cloneElement(child, {
        "aria-describedby": open ? [child.props["aria-describedby"], id].filter(Boolean).join(" ") : child.props["aria-describedby"],
        title: "",
      })
    : <span>{label}</span>;

  const triggerProps = {
    ref: rootRef,
    className: cn("relative inline-flex", isTextTrigger && "cursor-help max-md:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-content-strong/60", className),
    "data-managed-tooltip": "true",
    onMouseEnter: (event: MouseEvent<HTMLSpanElement>) => {
      cancelRest.current?.();
      cancelRest.current = whenPointerRests(event.currentTarget, () => setOpen(true));
    },
    onMouseLeave: () => {
      if (!pinned.current && !rootRef.current?.contains(document.activeElement)) closeTip();
    },
    onPointerDownCapture: () => {
      markPointerInteraction();
      if (!isTextTrigger) closeTip();
    },
    onClickCapture: (event: MouseEvent<HTMLSpanElement>) => {
      if (event.detail > 0) markPointerInteraction();
      if (!isTextTrigger) closeTip();
      else {
        pinned.current = !pinned.current;
        setOpen(pinned.current);
      }
    },
    onKeyDownCapture: (event: KeyboardEvent<HTMLSpanElement>) => {
      if (isTextTrigger && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopPropagation();
        pinned.current = !pinned.current;
        setOpen(pinned.current);
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        closeTip();
      }
    },
    onFocusCapture: (event: FocusEvent<HTMLSpanElement>) => {
      if (!isPointerFocus(event.nativeEvent)) setOpen(true);
    },
    onBlurCapture: () => requestAnimationFrame(() => {
      if (!rootRef.current?.contains(document.activeElement)) closeTip();
    }),
  };

  const body = <>
    {trigger}
    {open && content && <FloatingLayer anchorRef={rootRef} placement="up" align={align} id={id} role="tooltip" className={cn(contrastTooltipSurfaceClasses, "max-w-[230px] font-normal")}>
      {content}
    </FloatingLayer>}
  </>;

  return isTextTrigger
    ? <span {...triggerProps} role="button" tabIndex={0} aria-expanded={open} aria-describedby={open ? id : undefined}>{body}</span>
    : <span {...triggerProps} role="presentation">{body}</span>;
}
