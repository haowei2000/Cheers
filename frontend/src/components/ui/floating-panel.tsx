import { useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Maximize2, Minimize2, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import { LaneLayoutContext } from "@/hooks/useLaneWindow";
import { ResizeGrip } from "@/components/ui/resize-grip";

// A NON-MODAL floating window (ViewBoard-style chrome): rounded elevated card,
// no backdrop, so the chat + composer behind it stay fully usable. Draggable by
// its title bar and resizable from the bottom-right grip (geometry persists per
// `storageKey`); clicking anywhere in the window raises it above the others; the
// Minimize button collapses it to a compact title bar.
//
// Placement depends on context: inside the work lane (LaneLayoutContext = "grid")
// it renders as a tiled grid cell the lane sizes and positions — no drag/resize.
// With no lane it floats `fixed` over the whole viewport, draggable/resizable.
//
// Mobile: a full-screen sheet (drag/resize/minimize disabled), mirroring
// Dialog's fullScreenOnMobile behavior so heavy panels are never crushed.
export function FloatingPanel({
  title,
  icon: Icon,
  onClose,
  storageKey,
  className,
  defaultPosClassName = "top-20 left-1/2 -translate-x-1/2",
  bodyClassName,
  headerExtra,
  collapsedSummary,
  children,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  onClose: () => void;
  /** localStorage key for the window geometry (also the z-order identity). */
  storageKey: string;
  /** Default size of the card, e.g. "w-[640px]" or "w-[1024px] h-[85%]"
   *  (ignored once the window is resized or while collapsed). */
  className?: string;
  /** Where the window sits before it is ever dragged (relative to its box). */
  defaultPosClassName?: string;
  bodyClassName?: string;
  /** Extra header controls, rendered between the title and the close button. */
  headerExtra?: ReactNode;
  /** Minimized glance (ViewBoard-style): a compact key-signal summary shown in
   *  place of the body while collapsed. `expand` reopens the panel — wire it to
   *  the glance rows so clicking a signal expands straight to the full view.
   *  When omitted, collapsed is just a bare title chip. */
  collapsedSummary?: (expand: () => void) => ReactNode;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const layout = useContext(LaneLayoutContext);
  // In the lane grid the panel is a tiled cell (the grid sizes/positions it — no
  // drag/resize). With no lane it stays a free-floating window over the viewport.
  const grid = !isMobile && layout === "grid";
  const drag = useWindowDrag(storageKey, !isMobile && !grid, undefined);
  // Minimized = just the title bar (a compact chip you can park anywhere).
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(`${storageKey}.min`) === "1"
  );
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(`${storageKey}.min`, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  // On mobile the panel renders as a full-screen sheet that covers the app —
  // modal-like — so it earns the same Esc-to-dismiss as Dialog. The desktop
  // window is non-modal (chat stays usable behind it) and keeps close-button
  // only. Skip defaultPrevented so a nested popover/menu still claims its own Esc.
  useEffect(() => {
    if (!isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        // Claim this Escape so, with several sheets/menus mounted, only the first
        // to handle it closes — the rest see defaultPrevented and stand down.
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isMobile, onClose]);

  // Grid cell: no inline geometry (the grid owns it). Free-floating: collapsed
  // keeps the dragged position but sheds the resized width/height.
  const style: CSSProperties | undefined = grid
    ? undefined
    : collapsed && !isMobile
      ? drag.posStyle
      : drag.style;

  // Title label. While collapsed the whole label is the expand target (a much
  // bigger hit area than the 14px restore icon); the button wrapper also opts
  // the label out of the drag handle (useWindowDrag ignores pointerdowns on
  // buttons), so a click reliably expands instead of half-starting a drag.
  const titleLabel = (
    <>
      {Icon && <Icon className="w-4 h-4 text-zinc-400 flex-shrink-0" />}
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 truncate">
        {title}
      </span>
    </>
  );
  const titleEl = collapsed ? (
    <button
      type="button"
      onClick={toggleCollapsed}
      title="Expand"
      className="flex items-center gap-2 min-w-0 -mx-1 rounded px-1 py-0.5 hover:bg-zinc-800/60"
    >
      {titleLabel}
    </button>
  ) : (
    titleLabel
  );

  // Collapsed body: the ViewBoard-style glance, if the panel supplies one.
  const summaryEl =
    collapsed && !isMobile && collapsedSummary ? (
      <div className="min-h-0 overflow-y-auto overscroll-contain p-1.5">
        {collapsedSummary(toggleCollapsed)}
      </div>
    ) : null;
  // Collapsed width: a compact glance column when there's a summary, else a
  // content-hugging title chip.
  const collapsedWidth = collapsedSummary ? "w-[248px]" : "w-auto";

  return (
    <div
      ref={grid ? undefined : drag.ref}
      onPointerDownCapture={grid ? undefined : drag.toFront}
      style={style}
      className={cn(
        // Borderless (DESIGN.md §2.4): shadow-2xl is the draggable-window elevation.
        "flex flex-col overflow-hidden rounded-xl bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur-sm",
        // Mobile: full-screen sheet — position/size overrides beat the defaults.
        "max-md:inset-0 max-md:max-w-none max-md:max-h-none max-md:w-auto max-md:rounded-none max-md:translate-x-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]",
        grid
          ? // Grid cell: fill the cell; collapsed shrinks to content height and
            // parks at the top of the cell instead of stretching full-height.
            cn("relative w-full", collapsed ? "h-auto self-start max-h-full" : "h-full")
          : // Free-floating window over the viewport.
            cn(
              "fixed",
              "max-w-[94vw] max-h-[calc(100dvh-10rem)]",
              !drag.pos && defaultPosClassName,
              collapsed && !isMobile ? collapsedWidth : className
            )
      )}
    >
      <div
        {...(grid ? {} : drag.handleProps)}
        className="flex items-center gap-2 px-3 h-10 border-b border-zinc-800 flex-shrink-0 select-none"
      >
        {titleEl}
        <div className="flex-1" />
        {!collapsed && headerExtra}
        <button
          onClick={toggleCollapsed}
          title={collapsed ? "Expand" : "Minimize"}
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 max-md:hidden"
        >
          {collapsed ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {collapsed && !isMobile ? (
        summaryEl
      ) : (
        <div
          className={cn(
            "flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3",
            bodyClassName
          )}
        >
          {children}
        </div>
      )}
      {!collapsed && !isMobile && !grid && <ResizeGrip resizeProps={drag.resizeProps} />}
    </div>
  );
}
