import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { FloatingLayer } from "./floating-layer";
import { IconButton } from "./icon-button";

export type OverflowStrategy = "singleLine" | "wrap" | "horizontalScroll";

export interface OverflowTextProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  fullText: string;
  strategy?: OverflowStrategy;
  reveal?: "auto" | "none";
  children?: ReactNode;
  onOverflowChange?: (overflowing: boolean) => void;
  /** ItemRow owns its separate touch disclosure action. */
  touchDisclosure?: boolean;
}

export function OverflowText({
  fullText,
  strategy = "singleLine",
  reveal = "auto",
  children,
  className,
  onOverflowChange,
  touchDisclosure = true,
  ...props
}: OverflowTextProps) {
  const id = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const hoverTimer = useRef<number>();
  const [overflowing, setOverflowing] = useState(false);
  const [open, setOpen] = useState(false);

  const measure = useCallback(() => {
    const node = textRef.current;
    if (!node) return;
    const next = node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
    setOverflowing(next);
    onOverflowChange?.(next);
    if (!next) setOpen(false);
  }, [onOverflowChange]);

  useEffect(() => {
    measure();
    const node = textRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fullText, measure]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const canReveal = reveal === "auto" && overflowing;
  const showLater = () => {
    if (!canReveal) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setOpen(true), 400);
  };
  const hideLater = () => {
    window.clearTimeout(hoverTimer.current);
    setOpen(false);
  };

  return (
    <span ref={rootRef} className={cn("relative inline-flex min-w-0 max-w-full items-center", className)} {...props}>
      <span
        ref={textRef}
        tabIndex={canReveal ? 0 : undefined}
        aria-describedby={open ? id : undefined}
        className={cn(
          "min-w-0 max-w-full",
          strategy === "singleLine" && "block overflow-hidden text-ellipsis whitespace-nowrap",
          strategy === "wrap" && "whitespace-pre-wrap [overflow-wrap:anywhere]",
          strategy === "horizontalScroll" && "block overflow-x-auto whitespace-pre",
        )}
        onMouseEnter={showLater}
        onMouseLeave={hideLater}
        onFocus={() => canReveal && setOpen(true)}
        onBlur={hideLater}
      >
        {children ?? fullText}
      </span>
      {canReveal && touchDisclosure && (
        <IconButton
          label={`Show full text: ${fullText}`}
          controlSize="compact"
          className="ml-1 hidden max-md:inline-flex"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Info className="h-3.5 w-3.5" />
        </IconButton>
      )}
      {canReveal && open && (
        <FloatingLayer
          anchorRef={rootRef}
          placement="up"
          align="start"
          id={id}
          role="tooltip"
          className="max-w-[min(28rem,calc(100vw-2rem))] whitespace-pre-wrap rounded-sm bg-zinc-700 px-3 py-2 font-utility text-regular text-zinc-100 shadow-xl shadow-black/40 [overflow-wrap:anywhere]"
        >
          {fullText}
        </FloatingLayer>
      )}
    </span>
  );
}
