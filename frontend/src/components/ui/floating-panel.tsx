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
}

type PanelNavigationHost = {
  availableWidth: number;
  target: HTMLElement | null;
  setPresent: (present: boolean) => void;
};

const PanelNavigationContext = createContext<PanelNavigationHost | null>(null);
type PanelContextHost = {
  target: HTMLElement | null;
  setPresent: (present: boolean) => void;
};
const PanelContextContext = createContext<PanelContextHost | null>(null);
type PanelActionRegistrar = (ownerId: string, action: FloatingPanelAction | null) => void;
const PanelActionContext = createContext<PanelActionRegistrar | null>(null);

function intrinsicInlineWidth(host: HTMLElement): number {
  const row = host.firstElementChild;
  if (!(row instanceof HTMLElement)) return host.scrollWidth;
  const rowStyle = getComputedStyle(row);
  if (rowStyle.display !== "flex" && rowStyle.display !== "inline-flex") {
    return Math.max(host.scrollWidth, row.scrollWidth);
  }
  const children = Array.from(row.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute("data-adaptive-measurements")
  );
  const gap = Number.parseFloat(rowStyle.columnGap || rowStyle.gap) || 0;
  const padding =
    (Number.parseFloat(rowStyle.paddingLeft) || 0) +
    (Number.parseFloat(rowStyle.paddingRight) || 0);
  const childWidths = children.reduce(
    (total, child) => total + Math.max(child.getBoundingClientRect().width, child.scrollWidth),
    0
  );
  return Math.max(host.scrollWidth, childWidths + Math.max(0, children.length - 1) * gap + padding);
}

/** Lets a nested view (Workbench scenes) move only its primary navigation into chrome. */
export function FloatingPanelPrimaryNavigation({
  items,
  ariaLabel,
  presentationOrder,
  mobile,
}: FloatingPanelNavigation & { mobile?: ReactNode }) {
  const host = useContext(PanelNavigationContext);
  const setPresent = host?.setPresent;
  useEffect(() => {
    if (!setPresent) return;
    setPresent(true);
    return () => setPresent(false);
  }, [setPresent]);
  return (
    <>
      {mobile && <div className="md:hidden">{mobile}</div>}
      {host?.target && createPortal(
        <AdaptiveControlGroup
          kind="navigation"
          ariaLabel={ariaLabel}
          items={items}
          availableWidth={host.availableWidth}
          presentationOrder={presentationOrder}
        />,
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
  panelActions = [],
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
  /** Panel-wide source/scope controls rendered in a separate chrome island. */
  panelContext?: ReactNode;
  /** Structured panel actions; secondary actions collapse into More when narrow. */
  panelActions?: FloatingPanelAction[];
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
  const [stackedChrome, setStackedChrome] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(false);
  const [condensedTitle, setCondensedTitle] = useState(false);
  const [panelWidth, setPanelWidth] = useState(0);

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
  const [contextElement, setContextElement] = useState<HTMLDivElement | null>(null);
  const [contextTarget, setContextTarget] = useState<HTMLDivElement | null>(null);
  const [contextHeight, setContextHeight] = useState(0);
  const [portalNavigationPresent, setPortalNavigationPresent] = useState(false);
  const [portalContextPresent, setPortalContextPresent] = useState(false);
  const [portalActions, setPortalActions] = useState<Record<string, FloatingPanelAction>>({});
  const fullTitleWidth = useRef(0);
  const wideNavigationWidth = useRef(0);
  const compactNavigationWidth = useRef(0);
  const wideActionsWidth = useRef(0);
  const dragRef = drag.ref;
  const panelRef = useCallback(
    (element: HTMLDivElement | null) => {
      dragRef(element);
      setPanelElement(element);
    },
    [dragRef]
  );

  useEffect(() => {
    if (!contextElement || typeof ResizeObserver === "undefined") return;
    const measure = () => setContextHeight(contextElement.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(contextElement);
    return () => observer.disconnect();
  }, [contextElement]);

  const hasNavigation = primaryNavigation != null || portalNavigationPresent;
  const hasContext = panelContext != null || portalContextPresent;
  const useCompactNavigation = compactNavigation || stackedChrome;
  const chromeTop = hasNavigation && stackedChrome ? "5.5rem" : "3.5rem";
  const panelStyle = {
    ...style,
    "--floating-panel-chrome-top": chromeTop,
    "--floating-panel-safe-top": hasContext
      ? `calc(var(--floating-panel-chrome-top) + ${contextHeight}px + 0.5rem)`
      : chromeTop,
  } as CSSProperties;
  const navigationHost = {
    availableWidth: Math.max(132, panelWidth * (stackedChrome ? 0.72 : 0.42)),
    target: navigationTarget,
    setPresent: setPortalNavigationPresent,
  };
  const contextHost = {
    target: contextTarget,
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
  // Chrome adapts to the rendered controls rather than a fixed panel-width breakpoint.
  // This matters when a localized title, a longer tab set, or extension actions change
  // the space budget without changing the window width.
  useLayoutEffect(() => {
    if (!panelElement || !titleElement || !navigationTarget || !actionsElement) return;
    const measure = () => {
      const width = panelElement.getBoundingClientRect().width;
      setPanelWidth(width);
      const titleWidth = Math.max(titleElement.getBoundingClientRect().width, titleElement.scrollWidth);
      // max-width constrains the island box, but its tab strip can still overflow.
      // Collision decisions need the controls' intrinsic width, not the clipped box.
      const navigationWidth = Math.max(
        navigationTarget.getBoundingClientRect().width,
        intrinsicInlineWidth(navigationTarget)
      );
      const actionsWidth = Math.max(
        actionsElement.getBoundingClientRect().width,
        actionsElement.scrollWidth
      );

      if (!condensedTitle) fullTitleWidth.current = Math.max(fullTitleWidth.current, titleWidth);
      if (useCompactNavigation) {
        compactNavigationWidth.current = Math.max(compactNavigationWidth.current, navigationWidth);
      } else {
        wideNavigationWidth.current = Math.max(wideNavigationWidth.current, navigationWidth);
      }
      if (!stackedChrome) {
        wideActionsWidth.current = Math.max(wideActionsWidth.current, actionsWidth);
      }

      const actionsBudget = wideActionsWidth.current || actionsWidth;
      const titleBudget = fullTitleWidth.current || titleWidth;
      const islandGap = 12;
      const panelInset = 16;
      const navigationBudget = wideNavigationWidth.current || navigationWidth;
      const wideMinimum = Math.max(
        2 * (titleBudget + islandGap) + navigationBudget + panelInset,
        2 * (actionsBudget + islandGap) + navigationBudget + panelInset
      );
      const shouldCompact = hasNavigation && width < wideMinimum;
      setCompactNavigation(shouldCompact);

      const compactBudget = compactNavigationWidth.current || navigationWidth;
      const compactMinimum = Math.max(
        2 * (titleBudget + islandGap) + compactBudget + panelInset,
        2 * (actionsBudget + islandGap) + compactBudget + panelInset
      );
      const shouldStack = shouldCompact && useCompactNavigation && width < compactMinimum;
      setStackedChrome(shouldStack);

      // Once navigation occupies row two, row one may still become too tight. Keep
      // the panel identity icon and drag affordance, but let the title text collapse.
      const shouldCondenseTitle = shouldStack && width < titleBudget + actionsWidth + 72;
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
  }, [actionsElement, condensedTitle, hasNavigation, navigationTarget, panelElement, stackedChrome, titleElement, useCompactNavigation]);

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
        "group/floating-panel pointer-events-auto flex flex-col overflow-hidden rounded-concentric [--concentric-inset:1rem] bg-zinc-900/95 shadow-[0_24px_64px_rgba(0,0,0,0.56),0_2px_12px_rgba(0,0,0,0.36)] ring-1 ring-black/40 backdrop-blur-xl",
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
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 hidden opacity-0 transition-opacity duration-150 group-hover/floating-panel:opacity-100 group-focus-within/floating-panel:opacity-100 md:block">
            <div
              {...drag.handleProps}
              ref={setTitleElement}
              data-floating-panel-handle=""
              data-floating-panel-title=""
              className="pointer-events-auto absolute left-2 top-2 flex h-9 max-w-[34%] cursor-grab select-none items-center gap-2 rounded-concentric bg-zinc-950/80 px-2 shadow-lg ring-1 ring-white/10 backdrop-blur-xl active:cursor-grabbing"
            >
              <GripHorizontal className="h-4 w-4 flex-shrink-0 text-content-subtle" aria-hidden="true" />
              {titleLabel}
            </div>
            <div
              ref={setNavigationTarget}
              data-floating-panel-navigation=""
              className={cn(
                "pointer-events-auto absolute left-1/2 -translate-x-1/2",
                stackedChrome ? "top-12 max-w-[calc(100%-1rem)]" : "top-2 max-w-[42%]",
                hasNavigation && "min-h-9 rounded-concentric bg-zinc-950/80 p-1 shadow-lg ring-1 ring-white/10 backdrop-blur-xl"
              )}
            >
              {primaryNavigation && (
                <AdaptiveControlGroup
                  kind="navigation"
                  ariaLabel={primaryNavigation.ariaLabel}
                  items={primaryNavigation.items}
                  availableWidth={Math.max(132, panelWidth * (stackedChrome ? 0.72 : 0.42))}
                  presentationOrder={primaryNavigation.presentationOrder}
                />
              )}
            </div>
            <div
              ref={setActionsElement}
              data-floating-panel-actions=""
              className="pointer-events-auto absolute right-2 top-2 flex h-9 items-center gap-1 rounded-concentric bg-zinc-950/80 p-1 shadow-lg ring-1 ring-white/10 backdrop-blur-xl"
            >
              {allPanelActions.length > 0 && (
                <AdaptiveControlGroup
                  kind="actions"
                  ariaLabel="Panel actions"
                  items={allPanelActions}
                  availableWidth={Math.max(36, panelWidth * 0.3 - 72)}
                  presentationOrder={["iconText", "icon", "collapsed"]}
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
            </div>
          </div>

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
              ref={setContextElement}
              data-floating-panel-context=""
              className="relative z-30 mx-3 mt-2 flex min-h-9 flex-shrink-0 items-center rounded-concentric bg-zinc-950/80 p-1 shadow-lg ring-1 ring-white/10 backdrop-blur-xl md:pointer-events-auto md:absolute md:left-3 md:right-3 md:top-[var(--floating-panel-chrome-top)] md:mx-0 md:mt-0 md:opacity-0 md:transition-opacity md:duration-150 md:group-hover/floating-panel:opacity-100 md:group-focus-within/floating-panel:opacity-100"
            >
              {panelContext}
              <div ref={setContextTarget} className="min-w-0 flex-1" />
            </div>
          )}
          <PanelActionContext.Provider value={registerPortalAction}>
            <div
              data-floating-panel-content=""
              className={cn(
                "relative flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3 md:absolute md:inset-0",
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
