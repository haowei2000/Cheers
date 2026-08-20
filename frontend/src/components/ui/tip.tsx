import { cloneElement, isValidElement, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { FloatingLayer } from "./floating-layer";
import { IconButton } from "./icon-button";
import { contrastTooltipSurfaceClasses } from "./tooltip-surface";

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
  const [open, setOpen] = useState(false);

  const trigger =
    children && isValidElement(children) ? (
      cloneElement(children as ReactElement<{ "aria-describedby"?: string; title?: string }>, {
        "aria-describedby": id,
        title: "",
      })
    ) : (
      <IconButton
        label={label}
        title=""
        controlSize="compact"
        aria-describedby={id}
        className="-m-1 text-content-primary transition-colors hover:text-content-strong"
      >
        <Info className="h-3.5 w-3.5" />
      </IconButton>
    );

  return (
    <span
      ref={rootRef}
      className={cn("relative inline-flex", className)}
      data-managed-tooltip="true"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => requestAnimationFrame(() => !rootRef.current?.contains(document.activeElement) && setOpen(false))}
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
