import { useState, type CSSProperties, type ReactNode } from "react";
import { Maximize2, Minimize2, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import { ResizeGrip } from "@/components/ui/resize-grip";

// A NON-MODAL floating window (ViewBoard-style chrome): rounded elevated card,
// no backdrop, so the chat + composer behind it stay fully usable. Draggable by
// its title bar and resizable from the bottom-right grip (geometry persists per
// `storageKey`); clicking anywhere in the window raises it above the other
// floating windows; the Minimize button collapses it to a compact title bar.
// Used by Channel files and the Remote workspace — the surfaces that used to be
// centered modals.
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
  docked,
  dockedClassName,
  children,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  onClose: () => void;
  /** localStorage key for the window geometry (also the z-order identity). */
  storageKey: string;
  /** Default width of the card, e.g. "w-[640px]" (ignored while collapsed/resized). */
  className?: string;
  /** Where the window sits before it is ever dragged. */
  defaultPosClassName?: string;
  bodyClassName?: string;
  /** Extra header controls, rendered between the title and the close button. */
  headerExtra?: ReactNode;
  /** Desktop: render as a DOCKED work-area column (static layout space, no
   *  drag/resize/minimize) instead of a floating window. Mobile keeps the
   *  full-screen sheet either way. */
  docked?: boolean;
  /** Flex sizing of the docked column, e.g. "shrink basis-[720px] min-w-[480px]". */
  dockedClassName?: string;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const drag = useWindowDrag(storageKey, !isMobile && !docked);
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

  // Collapsed keeps the dragged position but sheds the resized width/height.
  const style: CSSProperties = collapsed && !isMobile ? drag.posStyle : drag.style;

  if (docked && !isMobile) {
    // Same card chrome as the floating window — only the placement differs: a
    // static flex item inside the channel's work area. Collapsed keeps the
    // title-bar chip look (content-height, parked at the lane top).
    return (
      <div
        className={cn(
          "flex min-h-0 flex-col overflow-hidden rounded-xl bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur-sm",
          collapsed ? "w-[300px] shrink min-w-[10rem] self-start" : dockedClassName
        )}
      >
        <div className="flex items-center gap-2 px-3 h-10 border-b border-zinc-800 flex-shrink-0 select-none">
          {Icon && <Icon className="w-4 h-4 text-zinc-400 flex-shrink-0" />}
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 truncate">
            {title}
          </span>
          <div className="flex-1" />
          {!collapsed && headerExtra}
          <button
            onClick={toggleCollapsed}
            title={collapsed ? "Expand" : "Minimize"}
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            {collapsed ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onClose}
            title="Close"
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {!collapsed && (
          <div
            className={cn(
              "flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3",
              bodyClassName
            )}
          >
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={drag.ref}
      onPointerDownCapture={drag.toFront}
      style={style}
      className={cn(
        // Borderless (DESIGN.md §2.4): shadow-2xl is the draggable-window elevation.
        "fixed flex flex-col overflow-hidden rounded-xl bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur-sm",
        // Height cap leaves the composer line clear at the default top-16 spawn
        // (16 top offset + cap ≈ 6rem short of the bottom).
        "max-w-[94vw] max-h-[calc(100dvh-10rem)]",
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
      {!collapsed && <ResizeGrip resizeProps={drag.resizeProps} />}
    </div>
  );
}
