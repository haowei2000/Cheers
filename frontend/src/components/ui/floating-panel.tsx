import { useContext, useEffect, useState, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from "react";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import { LaneBoundsContext } from "@/hooks/laneBounds";
import { ResizeGrip } from "@/components/ui/resize-grip";
import { ActionButton } from "@/components/ui/action-button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import type { AnchorPlacement } from "@/components/ui/floating-layer";
import type { SpawnKind } from "@/features/chat/workbench/laneSnap";

// A NON-MODAL floating window (ViewBoard-style chrome): rounded-sm elevated card,
// no backdrop, so the chat + composer behind it stay fully usable. Draggable by
// its title bar and resizable from the bottom-right grip (geometry persists per
// `storageKey`); clicking anywhere in the window raises it above the others; the
// Minimize button collapses it to a compact title bar.
//
// Where it floats depends on context: inside a LaneBoundsContext (the work lane)
// it's `absolute`, drag/resize stay inside that box, and dragging snaps to the
// lane's grid zones (FancyZones-style). With no lane (e.g. the Channel files
// dialog on its own) it floats `fixed` over the whole viewport.
// Pass `viewport` when the panel is portaled to `document.body` — React context
// still sees the lane, but body-mounted `absolute` is the wrong containing block.
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
  spawnKind,
  viewport = false,
  anchorRef,
  reanchorOnOpen = false,
  anchorPlacement = "down",
  open = true,
  collapsed: collapsedProp,
  onToggleCollapsed,
  dropTarget,
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
  /** Where the window sits before it is ever dragged (relative to its box).
   *  Ignored once auto-spawn or a persisted geom places the window. */
  defaultPosClassName?: string;
  bodyClassName?: string;
  /** Extra header controls, rendered between the title and the close button. */
  headerExtra?: ReactNode;
  /** Minimized glance (ViewBoard-style): a compact key-signal summary shown in
   *  place of the body while collapsed. `expand` reopens the panel — wire it to
   *  the glance rows so clicking a signal expands straight to the full view.
   *  When omitted, collapsed is just a bare title chip. */
  collapsedSummary?: (expand: () => void) => ReactNode;
  /** Bias first-open placement inside the work lane (fill when alone). */
  spawnKind?: SpawnKind;
  /** Force viewport-fixed float even inside LaneBoundsContext (body portals). */
  viewport?: boolean;
  /** Place near this trigger on open (viewport mode). */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Recompute x/y from the anchor every open; keep resized w/h. */
  reanchorOnOpen?: boolean;
  /** Preferred side of an anchored viewport panel. */
  anchorPlacement?: AnchorPlacement;
  /** Visibility. Most callers conditionally render the panel instead and leave this
   *  alone. Pass it when the panel must stay MOUNTED while closed so its body state
   *  survives (the Workbench's file tree + selection, the ViewBoard's visited tabs) —
   *  a closed panel keeps its DOM but takes no space and cannot be interacted with. */
  open?: boolean;
  /** Controlled collapse. Omit to let the panel own it (persisted per storageKey);
   *  pass both when an outside owner holds the flag — the ViewBoard's `minimal` lives
   *  in useChannelInstruments and is toggled from other code paths. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Accept dropped files on the whole panel. `active` paints the drop highlight. */
  dropTarget?: {
    active?: boolean;
    onDrop: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
  };
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const laneBounds = useContext(LaneBoundsContext);
  // Bounded to the lane when one is present (snap on); otherwise floats free over
  // the viewport (snap off — nothing to snap to). `viewport` opts out of the lane
  // even when context is set (portals to document.body must do this).
  const getBounds = viewport ? undefined : (laneBounds ?? undefined);
  const drag = useWindowDrag(
    storageKey,
    !isMobile,
    getBounds,
    {
      snap: !isMobile && getBounds != null,
      spawnKind: !isMobile && getBounds != null ? spawnKind : undefined,
      open,
      anchorRef: viewport ? anchorRef : undefined,
      reanchorOnOpen: viewport ? reanchorOnOpen : false,
      anchorPlacement,
    }
  );
  // Minimized = just the title bar (a compact chip you can park anywhere). Owned here
  // and persisted per storageKey unless a caller passes `collapsed`, in which case the
  // caller owns the flag and this internal copy is unused.
  const [ownCollapsed, setOwnCollapsed] = useState(() => {
    // Guarded like the write below and like useWindowDrag's own read: storage can be
    // absent (server render) or throw (private mode). An unreadable flag just means
    // the panel opens expanded.
    try {
      return localStorage.getItem(`${storageKey}.min`) === "1";
    } catch {
      return false;
    }
  });
  const controlled = collapsedProp !== undefined;
  const collapsed = controlled ? collapsedProp : ownCollapsed;
  const toggleCollapsed = () => {
    if (controlled) {
      onToggleCollapsed?.();
      return;
    }
    setOwnCollapsed((c) => {
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
    if (!isMobile || !open) return;
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
  }, [isMobile, open, onClose]);

  // Collapsed keeps the dragged position but sheds the resized width/height.
  const style: CSSProperties = collapsed && !isMobile ? drag.posStyle : drag.style;

  // Title label. While collapsed the whole label is the expand target (a much
  // bigger hit area than the 14px restore icon); the button wrapper also opts
  // the label out of the drag handle (useWindowDrag ignores pointerdowns on
  // buttons), so a click reliably expands instead of half-starting a drag.
  const titleLabel = (
    <>
      {Icon && <Icon className="w-4 h-4 text-content-muted flex-shrink-0" />}
      <span className="text-compact font-semibold uppercase tracking-section text-content-muted truncate">
        {title}
      </span>
    </>
  );
  const titleEl = collapsed ? (
    <ControlTrigger
      controlSize="compact"
      controlWidth="fill"
      onClick={toggleCollapsed}
      title="Expand"
      className="min-w-0 -mx-1 px-1"
    >
      {titleLabel}
    </ControlTrigger>
  ) : (
    titleLabel
  );

  // Collapsed body: the ViewBoard-style glance, if the panel supplies one.
  const summaryEl =
    collapsed && !isMobile && collapsedSummary ? (
      <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
        {collapsedSummary(toggleCollapsed)}
      </div>
    ) : null;
  // Collapsed width: a compact glance column when there's a summary, else a
  // content-hugging title chip.
  const collapsedWidth = collapsedSummary ? "w-[248px]" : "w-auto";

  return (
    // The root is a window surface, not a control: dragging it moves the window and
    // dropping a package onto it loads that package. Neither is a widget interaction,
    // and the keyboard equivalents live on the controls inside (close, minimize, the
    // file picker the drop target duplicates).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={drag.ref}
      onPointerDownCapture={drag.toFront}
      onDrop={dropTarget?.onDrop}
      onDragOver={dropTarget?.onDragOver}
      onDragLeave={dropTarget?.onDragLeave}
      style={style}
      className={cn(
        // Borderless (DESIGN.md §2.4): shadow-2xl is the draggable-window elevation.
        // Absolute inside the lane, fixed over the viewport (drag.style sets the
        // matching `position` so this only decides the fallback box).
        drag.bounded ? "absolute" : "fixed",
        "flex flex-col overflow-hidden rounded-concentric [--concentric-inset:1rem] bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur-sm",
        // Cap to the box, leaving a 2rem inset in the lane so a default-spawned
        // window (and its bottom-right resize grip) always fits inside the
        // overflow-clip; or short of the composer over the viewport.
        drag.bounded
          ? "max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)]"
          : "max-w-[94vw] max-h-[calc(100dvh-10rem)]",
        // Mobile: full-screen sheet — position/size overrides beat the defaults.
        "max-md:inset-0 max-md:max-w-none max-md:max-h-none max-md:w-auto max-md:rounded-none max-md:translate-x-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]",
        !drag.pos && defaultPosClassName,
        collapsed && !isMobile ? collapsedWidth : className,
        dropTarget?.active && "ring-2 ring-amber-500/60",
        // Closed but mounted. `hidden` must come AFTER the hardcoded `flex` above:
        // cn() is tailwind-merge and the display group is last-wins, so placed earlier
        // a closed panel would still render. Mobile re-asserts `flex` (the sheet is a
        // flex column) and fades instead, keeping the slide-out it has today.
        !open &&
          "hidden max-md:flex max-md:opacity-0 max-md:translate-x-4 max-md:pointer-events-none",
        isMobile && "transition-[opacity,transform] duration-200"
      )}
    >
      <div
        {...drag.handleProps}
        className="flex h-9 flex-shrink-0 select-none items-center gap-2 border-b border-zinc-800 px-3"
      >
        {titleEl}
        <div className="flex-1" />
        {!collapsed && headerExtra}
        <ActionButton
          action={collapsed ? "expand" : "collapse"}
          context="disclosure"
          onClick={toggleCollapsed}
          accessibleLabel={collapsed ? "Expand panel" : "Minimize panel"}
          controlSize="compact"
          className="text-content-primary hover:bg-zinc-800 hover:text-content-strong max-md:hidden"
        />
        <ActionButton
          action="close"
          context="windowChrome"
          onClick={onClose}
          accessibleLabel="Close panel"
          controlSize="compact"
          className="text-content-primary hover:bg-zinc-800 hover:text-content-strong"
        />
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
      {!collapsed && !isMobile && <ResizeGrip resizeProps={drag.resizeProps} />}
    </div>
  );
}
