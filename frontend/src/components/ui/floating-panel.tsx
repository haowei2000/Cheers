import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import { LaneBoundsContext } from "@/hooks/laneBounds";
import { ResizeGrip } from "@/components/ui/resize-grip";
import { AdaptiveControlGroup, type AdaptiveControlItem, type AdaptiveControlPresentation } from "@/components/ui/adaptive-control-group";
import { ActionButton } from "@/components/ui/action-button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import type { AnchorPlacement } from "@/components/ui/floating-layer";
import type { SpawnKind } from "@/features/chat/workbench/laneSnap";

export interface FloatingPanelNavigation {
  items: AdaptiveControlItem[];
  ariaLabel: string;
  presentationOrder?: AdaptiveControlPresentation[];
  /** Keep a compact navigation strip as tabs; overflow scrolls instead of changing its shape. */
  scrollable?: boolean;
  trigger?: FloatingPanelControlTrigger;
}

/** Declarative visibility for panel-level chrome. Content-local affordances use
 * `FloatingPanelLocalControls` instead, so they never react to whole-panel hover. */
export type FloatingPanelControlVisibility = "persistent" | "panelHover";

export interface FloatingPanelControlTrigger {
  visibility?: FloatingPanelControlVisibility;
  /** Overrides the host's panelHoverDelayMs for this one control. */
  revealAfterMs?: number;
}

export interface FloatingPanelAction {
  id: string;
  label: string;
  priority?: "primary" | "secondary";
  icon?: LucideIcon;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  /** Optional rich full-width rendering; compact forms come from structured metadata. */
  control?: ReactNode;
  /** Optional custom menu rows for compound actions such as pinned files. */
  overflow?: ReactNode;
  trigger?: FloatingPanelControlTrigger;
}

type PanelHoverState = {
  hovered: boolean;
  focused: boolean;
  elapsedMs: number;
  mobile: boolean;
  defaultDelayMs: number;
};

/** Pure visibility contract for panel chrome. Kept exported so timing policy can
 * be tested without a DOM-specific test runner. */
export function isFloatingPanelControlVisible(
  trigger: FloatingPanelControlTrigger | undefined,
  state: PanelHoverState,
): boolean {
  if (state.mobile || state.focused || (trigger?.visibility ?? "panelHover") === "persistent") return true;
  if (!state.hovered) return false;
  const delay = Math.max(0, trigger?.revealAfterMs ?? state.defaultDelayMs);
  return state.elapsedMs >= delay;
}

type PanelNavigationHost = {
  availableWidth: number;
  target: HTMLElement | null;
  setPresent: (present: boolean, trigger?: FloatingPanelControlTrigger) => void;
};

const PanelNavigationContext = createContext<PanelNavigationHost | null>(null);
type PanelContextHost = {
  target: HTMLElement | null;
  setPresent: (present: boolean) => void;
};
const PanelContextContext = createContext<PanelContextHost | null>(null);
type PanelActionRegistrar = (ownerId: string, action: FloatingPanelAction | null) => void;
const PanelActionContext = createContext<PanelActionRegistrar | null>(null);
const PanelLocalControlsContext = createContext(false);

/** Owns a content region's hover/focus state. Pair it with
 * `FloatingPanelLocalControl` for filters and row tools that must not appear
 * merely because another part of the window is hovered. */
export function FloatingPanelLocalControls({
  children,
  className,
  revealAfterMs = 0,
}: {
  children: ReactNode;
  className?: string;
  revealAfterMs?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!hovered || focused || revealAfterMs <= 0) return;
    const remaining = Math.max(0, revealAfterMs - elapsedMs);
    const timer = window.setTimeout(() => setElapsedMs(revealAfterMs), remaining);
    return () => window.clearTimeout(timer);
  }, [elapsedMs, focused, hovered, revealAfterMs]);

  const beginHover = () => {
    setElapsedMs(0);
    setHovered(true);
  };
  const endHover = () => {
    setHovered(false);
    setElapsedMs(0);
  };
  const visible = focused || (hovered && elapsedMs >= revealAfterMs);

  return (
    <PanelLocalControlsContext.Provider value={visible}>
      <div
        data-floating-panel-local-region=""
        className={className}
        onPointerEnter={beginHover}
        onPointerLeave={endHover}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          const region = event.currentTarget;
          requestAnimationFrame(() => setFocused(region.contains(document.activeElement)));
        }}
      >
        {children}
      </div>
    </PanelLocalControlsContext.Provider>
  );
}

export function FloatingPanelLocalControl({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const visible = useContext(PanelLocalControlsContext);
  return (
    <div
      data-floating-panel-local-controls=""
      className={cn(
        "pointer-events-none invisible opacity-0 transition-opacity duration-150 max-md:pointer-events-auto max-md:visible max-md:opacity-100",
        visible && "pointer-events-auto visible opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Lets a nested view (Workbench scenes) move only its primary navigation into chrome. */
export function FloatingPanelPrimaryNavigation({
  items,
  ariaLabel,
  presentationOrder,
  scrollable,
  trigger,
  mobile,
}: FloatingPanelNavigation & { mobile?: ReactNode }) {
  const host = useContext(PanelNavigationContext);
  const setPresent = host?.setPresent;
  useEffect(() => {
    if (!setPresent) return;
    setPresent(true, trigger);
    return () => setPresent(false);
  }, [setPresent, trigger]);
  return (
    <>
      {mobile && <div className="md:hidden">{mobile}</div>}
      {host?.target && createPortal(
        <div data-floating-panel-primary-navigation="" className={cn("min-w-0 flex-[3]", scrollable && "overflow-x-auto chat-scrollbar")}>
          <AdaptiveControlGroup
            kind="navigation"
            ariaLabel={ariaLabel}
            items={items}
            availableWidth={host.availableWidth}
            presentationOrder={presentationOrder}
            className={scrollable ? "w-max" : undefined}
          />
        </div>,
        host.target,
      )}
    </>
  );
}

/** Promotes content-local navigation or selectors into the secondary chrome island. */
export function FloatingPanelContextPortal({
  children,
}: {
  children: ReactNode;
}) {
  const host = useContext(PanelContextContext);
  const setPresent = host?.setPresent;
  useEffect(() => {
    if (!setPresent) return;
    setPresent(true);
    return () => setPresent(false);
  }, [setPresent]);
  return host?.target ? createPortal(children, host.target) : null;
}

/** Lets active business content promote a panel-wide action into floating chrome. */
export function FloatingPanelActionPortal({
  action,
  active = true,
}: {
  action: FloatingPanelAction;
  active?: boolean;
}) {
  const register = useContext(PanelActionContext);
  const ownerId = useId();
  useEffect(() => {
    if (!register || !active) return;
    register(ownerId, action);
    return () => register(ownerId, null);
  }, [action, active, ownerId, register]);
  return null;
}

// A NON-MODAL floating window (ViewBoard-style chrome): rounded-sm elevated card,
// no backdrop, so the chat + composer behind it stay fully usable. Draggable by
// its title bar and resizable from the bottom-right grip (geometry persists per
// `storageKey`); clicking anywhere in the window raises it above the others; the
// Minimize button collapses it to a compact title bar.
//
// Where it floats depends on context: inside a LaneBoundsContext (the channel canvas)
// it's `absolute`, drag/resize stay inside that box, and dragging snaps to the
// canvas grid zones (FancyZones-style). With no canvas (e.g. the Channel files
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
  primaryNavigation,
  panelContext,
  panelContextTrigger,
  sideControls,
  sideControlsTrigger,
  panelActions = [],
  panelHoverDelayMs = 1000,
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
  /** Panel-level primary navigation rendered in its own floating island. */
  primaryNavigation?: FloatingPanelNavigation;
  /** Panel-wide source/scope controls rendered in the single-line navigation island. */
  panelContext?: ReactNode;
  panelContextTrigger?: FloatingPanelControlTrigger;
  /** A compact, persistent utility island beside the action rail. Use this for
   *  panel-local selectors that must not compete with the primary navigation. */
  sideControls?: ReactNode;
  sideControlsTrigger?: FloatingPanelControlTrigger;
  /** Structured panel actions; secondary actions collapse into More when narrow. */
  panelActions?: FloatingPanelAction[];
  /** Default delay before panelHover controls appear after entering the panel. */
  panelHoverDelayMs?: number;
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
  // Bounded to the canvas when one is present (snap on); otherwise floats free over
  // the viewport (snap off — nothing to snap to). `viewport` opts out of the canvas
  // even when context is set (portals to document.body must do this).
  const getBounds = viewport ? undefined : (laneBounds ?? undefined);
  const drag = useWindowDrag(
    storageKey,
    !isMobile,
    getBounds,
    {
      // First-open placement still uses spawnKind, but a normal drag should stop
      // exactly where the user releases it, like an independent desktop window.
      snap: false,
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

  // Collapsed keeps the dragged position but sheds the resized width/height. Mobile
  // keeps only stacking order: persisted desktop x/y/w/h must not override the
  // full-screen `inset-0` sheet geometry.
  const style: CSSProperties = isMobile
    ? { zIndex: drag.style.zIndex }
    : collapsed
      ? drag.posStyle
      : drag.style;
  const [condensedTitle, setCondensedTitle] = useState(false);
  const [panelWidth, setPanelWidth] = useState(0);
  const [navigationSlotWidth, setNavigationSlotWidth] = useState(0);

  // Title label. While collapsed the whole label is the expand target (a much
  // bigger hit area than the 14px restore icon); the button wrapper also opts
  // the label out of the drag handle (useWindowDrag ignores pointerdowns on
  // buttons), so a click reliably expands instead of half-starting a drag.
  const titleLabel = (
    <>
      {Icon && <Icon className="w-4 h-4 text-content-muted flex-shrink-0" />}
      <span
        className={cn(
          "text-compact font-semibold uppercase tracking-section text-content-muted truncate",
          condensedTitle && "md:hidden"
        )}
      >
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

  const [panelElement, setPanelElement] = useState<HTMLElement | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<HTMLDivElement | null>(null);
  const [titleElement, setTitleElement] = useState<HTMLDivElement | null>(null);
  const [actionsElement, setActionsElement] = useState<HTMLDivElement | null>(null);
  const [desktopContextTarget, setDesktopContextTarget] = useState<HTMLDivElement | null>(null);
  const [mobileContextTarget, setMobileContextTarget] = useState<HTMLDivElement | null>(null);
  const [portalNavigationPresent, setPortalNavigationPresent] = useState(false);
  const [portalNavigationTrigger, setPortalNavigationTrigger] = useState<FloatingPanelControlTrigger | undefined>();
  const [portalContextPresent, setPortalContextPresent] = useState(false);
  const [portalActions, setPortalActions] = useState<Record<string, FloatingPanelAction>>({});
  const [panelHovered, setPanelHovered] = useState(false);
  const [panelFocused, setPanelFocused] = useState(false);
  const [panelHoverElapsedMs, setPanelHoverElapsedMs] = useState(0);
  const fullTitleWidth = useRef(0);
  const dragRef = drag.ref;
  const panelRef = useCallback(
    (element: HTMLDivElement | null) => {
      dragRef(element);
      setPanelElement(element);
    },
    [dragRef]
  );

  const hasContext = panelContext != null || portalContextPresent;
  const hasPrimaryNavigation = primaryNavigation != null || portalNavigationPresent;
  const hasNavigation = hasPrimaryNavigation || hasContext;
  const chromeTop = "3.5rem";
  const panelStyle = {
    ...style,
    "--floating-panel-chrome-top": chromeTop,
    "--floating-panel-safe-top": chromeTop,
  } as CSSProperties;
  const setPortalNavigation = useCallback((present: boolean, trigger?: FloatingPanelControlTrigger) => {
    setPortalNavigationPresent(present);
    setPortalNavigationTrigger(present ? trigger : undefined);
  }, []);
  const navigationHost = {
    availableWidth: Math.max(96, navigationSlotWidth * (hasContext ? 0.58 : 1)),
    target: navigationTarget,
    setPresent: setPortalNavigation,
  };
  const contextHost = {
    target: isMobile ? mobileContextTarget : desktopContextTarget,
    setPresent: setPortalContextPresent,
  };
  const registerPortalAction = useCallback<PanelActionRegistrar>((ownerId, action) => {
    setPortalActions((current) => {
      if (action) return current[ownerId] === action ? current : { ...current, [ownerId]: action };
      if (!(ownerId in current)) return current;
      const next = { ...current };
      delete next[ownerId];
      return next;
    });
  }, []);
  const allPanelActions = useMemo(
    () => [...panelActions, ...Object.values(portalActions)],
    [panelActions, portalActions]
  );
  const persistentPanelActions = useMemo(
    () => allPanelActions.filter((action) => (action.trigger?.visibility ?? "panelHover") === "persistent"),
    [allPanelActions],
  );
  const hoverPanelActions = useMemo(
    () => allPanelActions.filter((action) => (action.trigger?.visibility ?? "panelHover") === "panelHover"),
    [allPanelActions],
  );
  const hoverDelays = useMemo(() => {
    const controls = [
      primaryNavigation?.trigger ?? portalNavigationTrigger,
      panelContextTrigger,
      sideControlsTrigger,
      ...hoverPanelActions.map((action) => action.trigger),
      undefined, // title chrome uses the panel default.
    ];
    return [...new Set(controls.map((trigger) => Math.max(0, trigger?.revealAfterMs ?? panelHoverDelayMs)))].sort((a, b) => a - b);
  }, [hoverPanelActions, panelContextTrigger, panelHoverDelayMs, primaryNavigation?.trigger, portalNavigationTrigger, sideControlsTrigger]);
  useEffect(() => {
    if (!panelHovered || panelFocused || isMobile) return;
    const nextDelay = hoverDelays.find((delay) => delay > panelHoverElapsedMs);
    if (nextDelay == null) return;
    const timer = window.setTimeout(() => setPanelHoverElapsedMs(nextDelay), nextDelay - panelHoverElapsedMs);
    return () => window.clearTimeout(timer);
  }, [hoverDelays, isMobile, panelFocused, panelHoverElapsedMs, panelHovered]);
  const hoverState: PanelHoverState = {
    hovered: panelHovered,
    focused: panelFocused,
    elapsedMs: panelHoverElapsedMs,
    mobile: isMobile,
    defaultDelayMs: panelHoverDelayMs,
  };
  const titleVisible = isFloatingPanelControlVisible(undefined, hoverState);
  const primaryNavigationVisible = isFloatingPanelControlVisible(primaryNavigation?.trigger ?? portalNavigationTrigger, hoverState);
  const contextVisible = isFloatingPanelControlVisible(panelContextTrigger, hoverState);
  const sideControlsVisible = isFloatingPanelControlVisible(sideControlsTrigger ?? { visibility: "persistent" }, hoverState);
  // Chrome adapts to the rendered controls rather than a fixed panel-width breakpoint.
  // This matters when a localized title, a longer tab set, or extension actions change
  // the space budget without changing the window width.
  useLayoutEffect(() => {
    if (!panelElement || !titleElement || !navigationTarget || !actionsElement) return;
    const measure = () => {
      const width = panelElement.getBoundingClientRect().width;
      setPanelWidth(width);
      const titleWidth = Math.max(titleElement.getBoundingClientRect().width, titleElement.scrollWidth);
      const actionsWidth = Math.max(
        actionsElement.getBoundingClientRect().width,
        actionsElement.scrollWidth
      );

      if (!condensedTitle) fullTitleWidth.current = Math.max(fullTitleWidth.current, titleWidth);
      const titleBudget = fullTitleWidth.current || titleWidth;
      const islandGap = 12;
      const panelInset = 16;
      const sideBudget = Math.max(titleBudget, actionsWidth);
      const available = Math.max(96, width - 2 * (sideBudget + islandGap) - panelInset);
      setNavigationSlotWidth(Math.min(width * 0.58, available));

      // Panel chrome is always one line. When the side islands leave too little room,
      // preserve the identity icon and let the title copy collapse.
      const shouldCondenseTitle = hasNavigation && available < 132;
      setCondensedTitle(shouldCondenseTitle);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panelElement);
    observer.observe(titleElement);
    observer.observe(navigationTarget);
    observer.observe(actionsElement);
    const mutations = new MutationObserver(measure);
    mutations.observe(navigationTarget, { childList: true, subtree: true, characterData: true });
    mutations.observe(actionsElement, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [actionsElement, condensedTitle, hasNavigation, navigationTarget, panelElement, titleElement]);

  return (
    // The root is a window surface, not a control: dragging it moves the window and
    // dropping a package onto it loads that package. Neither is a widget interaction,
    // and the keyboard equivalents live on the controls inside (close, minimize, the
    // file picker the drop target duplicates).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={panelRef}
      data-floating-panel=""
      data-floating-panel-bounded={drag.bounded ? "true" : "false"}
      onPointerDownCapture={drag.toFront}
      onPointerEnter={() => {
        setPanelHoverElapsedMs(0);
        setPanelHovered(true);
      }}
      onPointerLeave={() => {
        setPanelHovered(false);
        setPanelHoverElapsedMs(0);
      }}
      onFocusCapture={() => setPanelFocused(true)}
      onBlurCapture={(event) => {
        const panel = event.currentTarget;
        requestAnimationFrame(() => setPanelFocused(panel.contains(document.activeElement)));
      }}
      onDrop={dropTarget?.onDrop}
      onDragOver={dropTarget?.onDragOver}
      onDragLeave={dropTarget?.onDragLeave}
      style={panelStyle}
      className={cn(
        // Borderless (DESIGN.md §2.4): layered shadows give the draggable window a
        // clear edge without turning every surface into an outlined card.
        // Absolute inside the canvas, fixed over the viewport (drag.style sets the
        // matching `position` so this only decides the fallback box).
        isMobile ? "fixed" : drag.bounded ? "absolute" : "fixed",
        "floating-panel-surface group/floating-panel pointer-events-auto flex flex-col overflow-hidden rounded-concentric [--concentric-inset:1rem] shadow-[0_24px_64px_rgba(0,0,0,0.56),0_2px_12px_rgba(0,0,0,0.36)] ring-1 ring-black/40",
        // Cap to the box, leaving a 2rem inset in the canvas so a default-spawned
        // window (and its bottom-right resize grip) always fits inside the
        // overflow-clip; or short of the composer over the viewport.
        drag.bounded
          ? "max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)]"
          : "max-w-[94vw] max-h-[calc(100dvh-10rem)]",
        // Mobile: full-screen sheet — position/size overrides beat the defaults.
        "max-md:inset-0 max-md:max-w-none max-md:max-h-none max-md:w-auto max-md:h-auto max-md:rounded-none max-md:translate-x-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]",
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
      {collapsed && !isMobile ? (
        <>
          <div
            {...drag.handleProps}
            data-floating-panel-handle=""
            className="flex h-11 flex-shrink-0 cursor-grab select-none items-center gap-2 px-3 active:cursor-grabbing"
          >
            <GripHorizontal className="h-4 w-4 flex-shrink-0 text-content-subtle" aria-hidden="true" />
            {titleEl}
            <div className="flex-1" />
            <ActionButton
              action="expand"
              context="disclosure"
              onClick={toggleCollapsed}
              accessibleLabel="Expand panel"
              controlSize="compact"
              className="text-content-primary hover:bg-zinc-800 hover:text-content-strong"
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
          {summaryEl}
        </>
      ) : (
        <PanelNavigationContext.Provider value={navigationHost}>
          <PanelContextContext.Provider value={contextHost}>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 hidden h-14 md:block">
            <div
              {...drag.handleProps}
              ref={setTitleElement}
              data-floating-panel-handle=""
              data-floating-panel-title=""
              className={cn(
                "floating-control-surface pointer-events-none absolute left-2 top-2 flex h-9 max-w-[34%] cursor-grab select-none items-center gap-2 rounded-concentric px-2 opacity-0 transition-opacity active:cursor-grabbing",
                titleVisible && "pointer-events-auto opacity-100",
              )}
            >
              <GripHorizontal className="h-4 w-4 flex-shrink-0 text-content-subtle" aria-hidden="true" />
              {titleLabel}
            </div>
            <div
              ref={setNavigationTarget}
              data-floating-panel-navigation=""
              className={cn(
                "pointer-events-none absolute left-1/2 top-2 flex h-9 -translate-x-1/2 items-center gap-1 overflow-hidden whitespace-nowrap opacity-0 transition-opacity",
                (primaryNavigationVisible || contextVisible) && "pointer-events-auto opacity-100",
                hasNavigation && "floating-control-surface rounded-concentric p-1"
              )}
              style={{ width: navigationSlotWidth || undefined, maxWidth: "58%" }}
            >
              {primaryNavigation && (
                <div data-floating-panel-primary-navigation="" className={cn("min-w-0 flex-[3]", primaryNavigation.scrollable && "overflow-x-auto chat-scrollbar")}>
                  <AdaptiveControlGroup
                    kind="navigation"
                    ariaLabel={primaryNavigation.ariaLabel}
                    items={primaryNavigation.items}
                    availableWidth={Math.max(96, navigationSlotWidth * (hasContext ? 0.58 : 1))}
                    presentationOrder={primaryNavigation.presentationOrder}
                    className={primaryNavigation.scrollable ? "w-max" : undefined}
                  />
                </div>
              )}
              {hasContext && (
                <div
                  data-floating-panel-context=""
                  className="pointer-events-auto flex min-w-0 flex-[2] items-center overflow-hidden"
                >
                  {panelContext && <div className="min-w-0 flex-1 overflow-hidden">{panelContext}</div>}
                  <div
                    ref={setDesktopContextTarget}
                    className={cn(
                      "min-w-0",
                      portalContextPresent ? "flex-1" : panelContext ? "w-0 overflow-hidden" : "w-full"
                    )}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Persistent action rail: actions never cover the body. Its reserved
              width lets Save/close remain one-click reachable without a top
              hover target competing with the first content row. */}
          <div
            ref={setActionsElement}
            data-floating-panel-actions=""
            className="floating-control-surface pointer-events-auto absolute right-2 top-2 z-30 hidden w-9 flex-col items-center gap-1 rounded-concentric p-1 md:flex"
          >
            {persistentPanelActions.length > 0 && (
              <AdaptiveControlGroup
                kind="actions"
                ariaLabel="Panel actions"
                items={persistentPanelActions}
                availableWidth={28}
                presentationOrder={["icon", "collapsed"]}
                className="flex-col"
              />
            )}
            <ActionButton
              action="collapse"
              context="disclosure"
              onClick={toggleCollapsed}
              accessibleLabel="Minimize panel"
              controlSize="compact"
              className="text-content-primary hover:bg-zinc-800 hover:text-content-strong"
            />
            <ActionButton
              action="close"
              context="windowChrome"
              onClick={onClose}
              accessibleLabel="Close panel"
              controlSize="compact"
              className="text-content-primary hover:bg-zinc-800 hover:text-content-strong"
            />
            {hoverPanelActions.length > 0 && (
              // design-system-exempt: menu-option — visibility wrapper; each child is an AdaptiveControlGroup.
              hoverPanelActions.map((action) => (
                <div
                  key={action.id}
                  className={cn(
                    "pointer-events-none invisible opacity-0 transition-opacity",
                    isFloatingPanelControlVisible(action.trigger, hoverState) && "pointer-events-auto visible opacity-100",
                  )}
                >
                  <AdaptiveControlGroup
                    kind="actions"
                    ariaLabel={action.label}
                    items={[action]}
                    availableWidth={28}
                    presentationOrder={["icon"]}
                    className="flex-col"
                  />
                </div>
              ))
            )}
          </div>
          {sideControls && (
            <div
              data-floating-panel-side-controls=""
              className={cn(
                "floating-control-surface pointer-events-none absolute right-14 top-2 z-30 hidden items-center rounded-concentric p-1 opacity-0 transition-opacity md:flex",
                sideControlsVisible && "pointer-events-auto opacity-100",
              )}
            >
              {sideControls}
            </div>
          )}

          <div
            {...drag.handleProps}
            data-floating-panel-handle=""
            className="flex h-11 flex-shrink-0 cursor-grab select-none items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/35 px-3 active:cursor-grabbing md:hidden"
          >
            <GripHorizontal className="h-4 w-4 flex-shrink-0 text-content-subtle" aria-hidden="true" />
            {titleLabel}
            <div className="flex-1" />
            {allPanelActions.map((action) => <div key={action.id}>{action.control}</div>)}
            <ActionButton
              action="close"
              context="windowChrome"
              onClick={onClose}
              accessibleLabel="Close panel"
              controlSize="compact"
              className="text-content-primary hover:bg-zinc-800 hover:text-content-strong"
            />
          </div>
          {hasContext && (
            <div
              data-floating-panel-context=""
              className="floating-control-surface pointer-events-none relative z-30 mx-3 mt-2 flex min-h-9 flex-shrink-0 items-center overflow-hidden rounded-concentric p-1 md:hidden"
            >
              {panelContext && <div className="pointer-events-auto min-w-0 flex-1">{panelContext}</div>}
              <div
                ref={setMobileContextTarget}
                className={cn(
                  "pointer-events-auto min-w-0",
                  portalContextPresent ? "flex-1" : panelContext ? "w-0 overflow-hidden" : "w-full"
                )}
              />
            </div>
          )}
          <PanelActionContext.Provider value={registerPortalAction}>
            <div
              data-floating-panel-content=""
              className={cn(
                // Chrome stays an overlay so the body can use the full canvas.
                // Scroll padding still keeps programmatic focus/jumps from landing
                // beneath a revealed control island, without a permanent blank row.
                "relative flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3 md:absolute md:inset-0 md:pr-14 md:scroll-pt-[var(--floating-panel-safe-top)]",
                bodyClassName
              )}
            >
              {children}
            </div>
          </PanelActionContext.Provider>
          {!isMobile && <ResizeGrip resizeProps={drag.resizeProps} />}
          </PanelContextContext.Provider>
        </PanelNavigationContext.Provider>
      )}
    </div>
  );
}
