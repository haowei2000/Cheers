import { cloneElement, isValidElement, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { FloatingLayer } from "./floating-layer";

// Hover help (DESIGN.md §2.14). Supplementary explanation that shows on hover
// AND keyboard focus (touch: tapping the trigger focuses it → reveals the tip).
// The bubble is a lighter transient layer (bg-zinc-700) so it separates from the
// zinc-900 card, role="tooltip", associated to its trigger via aria-describedby.
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
      cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby": id,
      })
    ) : (
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        // Small glyph, but pad the hit target out to a usable size.
        className="-m-1 inline-flex items-center justify-center rounded p-1 text-zinc-500 transition-colors hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    );

  return (
    <span
      ref={rootRef}
      className={cn("relative inline-flex", className)}
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
          className="pointer-events-none w-max max-w-[230px] rounded-lg bg-zinc-700 px-2.5 py-1.5 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-zinc-100 shadow-xl shadow-black/40"
        >
          {content}
        </FloatingLayer>
      )}
    </span>
  );
}
