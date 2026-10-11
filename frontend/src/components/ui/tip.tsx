import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { FloatingLayer } from "./floating-layer";
import { IconButton } from "./icon-button";
import { contrastTooltipSurfaceClasses } from "./tooltip-surface";
import { isPointerFocus, markPointerInteraction, onDisarmHover, whenPointerRests } from "@/lib/hoverIntent";

// Hover help (DESIGN.md §2.14). Supplementary explanation that shows on hover
// AND keyboard focus (touch: tapping the trigger focuses it → reveals the tip).
// The bubble is a high-contrast transient layer, role="tooltip", associated to
// its trigger via aria-describedby.
//
// Two forms:
//  - default trigger: `<Tip content="…" />` renders a small ⓘ info button.
//  - wrap a control: `<Tip content="…"><Button>Edit</Button></Tip>` — the child
//    becomes the trigger (aria-describedby is injected onto it).
//
// Never put need-to-know info here (validation errors, irreversible
// consequences) — those stay inline / in a confirm dialog.
export function Tip({
  content,
  children,
  align = "center",
  label = "More information",
  className,
}: {
  content: ReactNode;
  /** Trigger element; omit for the default ⓘ info button. */
  children?: ReactElement;
  /** Horizontal anchor of the bubble relative to the trigger. */
  align?: "start" | "center" | "end";
  /** Accessible name for the default ⓘ trigger (ignored when wrapping a child). */
  label?: string;
  className?: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const cancelRest = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);

  // Hover is a question the pointer asks by staying; focus is one the user asks
  // outright, so the keyboard path answers immediately. The dedicated help
  // button also toggles on click/tap; wrapped action controls keep their action.
  const closeTip = () => {
    cancelRest.current?.();
    cancelRest.current = null;
    pinned.current = false;
    setOpen(false);
  };

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
  }, []);

  const trigger =
    children && isValidElement(children) ? (
      cloneElement(children as ReactElement<{ "aria-describedby"?: string; title?: string }>, {
        "aria-describedby": open ? [(children as ReactElement<{ "aria-describedby"?: string }>).props["aria-describedby"], id].filter(Boolean).join(" ") : (children as ReactElement<{ "aria-describedby"?: string }>).props["aria-describedby"],
        title: "",
      })
    ) : (
      <IconButton
        label={label}
        title=""
        controlSize="compact"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        className="-m-1 text-content-primary transition-colors hover:text-content-strong"
      >
        <Info className="h-3.5 w-3.5" />
      </IconButton>
    );

  return (
    <span
      role="presentation"
      ref={rootRef}
      className={cn("relative inline-flex", className)}
      data-managed-tooltip="true"
      onMouseEnter={(event) => {
        cancelRest.current?.();
        cancelRest.current = whenPointerRests(event.currentTarget, () => setOpen(true));
      }}
      onMouseLeave={() => { if (!pinned.current) closeTip(); }}
      onPointerDownCapture={() => {
        markPointerInteraction();
        if (children) closeTip();
      }}
      onClickCapture={() => {
        markPointerInteraction();
        if (children) closeTip();
        else {
          pinned.current = !open;
          setOpen(!open);
        }
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          closeTip();
        }
      }}
      onFocusCapture={(event) => {
        if (isPointerFocus(event.nativeEvent)) return;
        setOpen(true);
      }}
      onBlurCapture={() =>
        requestAnimationFrame(() => !rootRef.current?.contains(document.activeElement) && closeTip())
      }
    >
      {trigger}
      {open && (
        <FloatingLayer
          anchorRef={rootRef}
          placement="up"
          align={align}
          id={id}
          role="tooltip"
          className={cn(contrastTooltipSurfaceClasses, "max-w-[230px] font-normal")}
        >
          {content}
        </FloatingLayer>
      )}
    </span>
  );
}
