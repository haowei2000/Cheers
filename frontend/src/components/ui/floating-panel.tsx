import { useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Maximize2, Minimize2, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import { LaneBoundsContext } from "@/hooks/useLaneWindow";
import { ResizeGrip } from "@/components/ui/resize-grip";

// A NON-MODAL floating window (ViewBoard-style chrome): rounded elevated card,
// no backdrop, so the chat + composer behind it stay fully usable. Draggable by
// its title bar and resizable from the bottom-right grip (geometry persists per
// `storageKey`); clicking anywhere in the window raises it above the others; the
// Minimize button collapses it to a compact title bar.
//
// Where it floats depends on context: inside a LaneBoundsContext (the work lane)
// it's `absolute` and drag/resize stay inside that box; with no lane (e.g. the
// Channel files dialog) it floats `fixed` over the whole viewport.
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
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const getBounds = useContext(LaneBoundsContext);
  // Bounded to the lane when one is present; otherwise floats over the viewport.
  const drag = useWindowDrag(storageKey, !isMobile, getBounds ?? undefined);
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

  // Collapsed keeps the dragged position but sheds the resized width/height.
  const style: CSSProperties = collapsed && !isMobile ? drag.posStyle : drag.style;

  return (
    <div
      ref={drag.ref}
      onPointerDownCapture={drag.toFront}
      style={style}
      className={cn(
        // Borderless (DESIGN.md §2.4): shadow-2xl is the draggable-window elevation.
        // Absolute inside the lane, fixed over the viewport (drag.style sets the
        // matching `position` so this only decides the fallback box).
        drag.bounded ? "absolute" : "fixed",
        "flex flex-col overflow-hidden rounded-xl bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur-sm",
        // Cap to the box, leaving a 2rem inset in the lane so a default-spawned
        // window (and its bottom-right resize grip) always fits inside the
        // overflow-clip; or short of the composer over the viewport.
        drag.bounded ? "max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)]" : "max-w-[94vw] max-h-[calc(100dvh-10rem)]",
        // Mobile: full-screen sheet — position/size overrides beat the defaults.
        "max-md:inset-0 max-md:max-w-none max-md:max-h-none max-md:w-auto max-md:rounded-none max-md:translate-x-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]",
        !drag.pos && defaultPosClassName,
        collapsed && !isMobile ? "w-[300px]" : className
      )}
    >
      <div
        {...drag.handleProps}
        className="flex items-center gap-2 px-3 h-10 border-b border-zinc-800 flex-shrink-0 select-none"
      >
        {Icon && <Icon className="w-4 h-4 text-zinc-400 flex-shrink-0" />}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 truncate">
          {title}
        </span>
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
      {(!collapsed || isMobile) && (
        <div
          className={cn(
            "flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3",
            bodyClassName
          )}
        >
          {children}
        </div>
      )}
      {!collapsed && !isMobile && <ResizeGrip resizeProps={drag.resizeProps} />}
    </div>
  );
}
