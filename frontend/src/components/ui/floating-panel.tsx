import { useManagedPanel } from "./managed-panel";
import { IconButton } from "./icon-button";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useState, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, PanelRightOpen, PanelRightClose, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import { LaneBoundsContext } from "@/hooks/laneBounds";
import { SharedLayoutContext } from "@/hooks/sharedLayout";
import { ResizeGrip } from "@/components/ui/resize-grip";
import { AdaptiveControlGroup, type AdaptiveControlItem, type AdaptiveControlPresentation } from "@/components/ui/adaptive-control-group";
import { ButtonGroup } from "@/components/ui/button-group";
import { ActionButton } from "@/components/ui/action-button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import type { AnchorPlacement } from "@/components/ui/floating-layer";
import type { SpawnKind } from "@/features/chat/workbench/laneSnap";

export interface FloatingPanelNavigation {
  items: AdaptiveControlItem[];
  ariaLabel: string;
  presentationOrder?: AdaptiveControlPresentation[];
  /** Collapsed-dropdown trigger form; "icon" suits a panel whose body already
   *  names the selected section. */
  collapsedContent?: "text" | "icon";
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

export function floatingPanelNavigationBudget(
  panelWidth: number,
  titleWidth: number,
): number {
  return Math.max(28, panelWidth - titleWidth - 40);
}

type PanelNavigationHost = {
  availableWidth: number;
  target: HTMLElement | null;
};

const PanelNavigationContext = createContext<PanelNavigationHost | null>(null);
type PanelContextHost = {
  target: HTMLElement | null;
  setPresent: (present: boolean) => void;
};
const PanelContextContext = createContext<PanelContextHost | null>(null);
type PanelActionRegistrar = (ownerId: string, action: FloatingPanelAction | null) => void;
const PanelActionContext = createContext<PanelActionRegistrar | null>(null);

/** Lets a nested view (Workbench scenes) move only its primary navigation into chrome. */
export function FloatingPanelPrimaryNavigation({
  items,
  ariaLabel,
  presentationOrder,
  mobile,
}: FloatingPanelNavigation & { mobile?: ReactNode }) {
  const host = useContext(PanelNavigationContext);
  return (
    <>
      {mobile && <div className="md:hidden">{mobile}</div>}
      {host?.target && createPortal(
        <div data-floating-panel-primary-navigation="" className="min-w-0 max-w-full shrink-0">
          <AdaptiveControlGroup
            kind="navigation"
            ariaLabel={ariaLabel}
            items={items}
            availableWidth={host.availableWidth}
            presentationOrder={presentationOrder}
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
  /** Panel-wide source/scope controls rendered in the single-line navigation island. */
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
  const managed = useManagedPanel(spawnKind, viewport);
  const managedVisible = managed?.visible;
  const laneBounds = useContext(LaneBoundsContext);
  const sharedLayout = useContext(SharedLayoutContext);
  // Bounded to the canvas when one is present (snap on); otherwise floats free over
  // the viewport (snap off — nothing to snap to). `viewport` opts out of the canvas
  // even when context is set (portals to document.body must do this).
  const getBounds = viewport ? undefined : (laneBounds ?? undefined);
  const drag = useWindowDrag(
    storageKey,
    !isMobile && !managed,
    getBounds,
    {
      // First-open placement still uses spawnKind, but a normal drag should stop
      // exactly where the user releases it, like an independent desktop window.
      snap: false,
      spawnKind: !isMobile && getBounds != null ? spawnKind : undefined,
      // The channel's placement for this window, when it is a lane window and the
      // channel has one. useWindowDrag adopts it only while this device has no
      // geometry of its own — see WindowDragOptions.sharedGeom.
      sharedGeom:
        !isMobile && getBounds != null && spawnKind ? (sharedLayout?.(spawnKind) ?? null) : null,
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
  const collapsed = !managed && (controlled ? collapsedProp : ownCollapsed);
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
    if (!isMobile || !open || managedVisible === false) return;
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
  }, [isMobile, managedVisible, onClose, open]);

  // Collapsed keeps the dragged position but sheds the resized width/height. Mobile
  // keeps only stacking order: persisted desktop x/y/w/h must not override the
  // full-screen `inset-0` sheet geometry.
  const style: CSSProperties = isMobile
    ? { zIndex: drag.style.zIndex }
    : collapsed
      ? drag.posStyle
      : drag.style;
  const [panelWidth, setPanelWidth] = useState(0);
  // Width of the top-RIGHT island, so the top-LEFT one knows where to stop.
  const [navigationSlotWidth, setNavigationSlotWidth] = useState(0);

  // Title label — for the two places the name is the ONLY identity: the collapsed pill
  // and the mobile header. The expanded desktop chrome shows the mark and the lit tab
  // instead. While collapsed the whole label is the expand target (a much bigger hit
  // area than the 14px restore icon); the button wrapper also opts the label out of the
  // drag handle (useWindowDrag ignores pointerdowns on buttons), so a click reliably
  // expands instead of half-starting a drag.
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

  const [panelElement, setPanelElement] = useState<HTMLElement | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<HTMLDivElement | null>(null);
  const [titleElement, setTitleElement] = useState<HTMLDivElement | null>(null);
  const [desktopContextTarget, setDesktopContextTarget] = useState<HTMLDivElement | null>(null);
  const [mobileContextTarget, setMobileContextTarget] = useState<HTMLDivElement | null>(null);
  const [portalContextPresent, setPortalContextPresent] = useState(false);
  const [portalActions, setPortalActions] = useState<Record<string, FloatingPanelAction>>({});
  const [chromeElement, setChromeElement] = useState<HTMLDivElement | null>(null);
  const [chromeHeight, setChromeHeight] = useState(36);
  const dragRef = drag.ref;
  const panelRef = useCallback(
    (element: HTMLDivElement | null) => {
      dragRef(element);
      setPanelElement(element);
    },
    [dragRef]
  );

  const hasContext = panelContext != null || portalContextPresent;
  const chromeTop = `${chromeHeight + 16}px`;
  const panelStyle = {
    ...style,
    ...(managed ? { ...managed.style, maxWidth: "none", maxHeight: "none", transform: "none", display: open && managed.visible ? "flex" : "none", ...(managed.floating ? {} : { borderRadius: 0, boxShadow: "none" }) } : {}),
    "--floating-panel-chrome-top": chromeTop,
    // Content that consumes this variable also renders below the separate mobile
    // header. The desktop chrome is measured, but that hidden desktop element has no
    // box below md, so keep the mobile-safe band explicit instead of collapsing it.
    "--floating-panel-safe-top": "3.5rem",
  } as CSSProperties;
  const navigationHost = {
    availableWidth: navigationSlotWidth,
    target: navigationTarget,
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
  // Chrome adapts to the rendered controls rather than a fixed panel-width breakpoint.
  // This matters when a localized title, a longer tab set, or extension actions change
  // the space budget without changing the window width.
  useLayoutEffect(() => {
    if (!panelElement || !titleElement || !navigationTarget) return;
    const measure = () => {
      const width = panelElement.getBoundingClientRect().width;
      setPanelWidth(width);
      const titleWidth = Math.max(titleElement.getBoundingClientRect().width, titleElement.scrollWidth);
      // Sibling groups wrap as whole units. Subtracting their width here made the
      // navigation collapse even after those siblings had moved to another row, where
      // the navigation actually owns the full panel width.
      setNavigationSlotWidth(floatingPanelNavigationBudget(width, titleWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panelElement);
    observer.observe(titleElement);
    observer.observe(navigationTarget);
    const mutations = new MutationObserver(measure);
    mutations.observe(navigationTarget, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [navigationTarget, panelElement, titleElement]);

  useLayoutEffect(() => {
    if (!chromeElement) return;
    const measure = () => setChromeHeight(chromeElement.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chromeElement);
    return () => observer.disconnect();
  }, [chromeElement]);

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
      onPointerDownCapture={managed?.toFront ?? drag.toFront}
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
          <ButtonGroup label="Panel window controls"
            {...drag.handleProps}
            data-floating-panel-handle=""
            className="flex min-h-11 flex-shrink-0 cursor-grab select-none items-center gap-2 px-3 active:cursor-grabbing"
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
          </ButtonGroup>
          {summaryEl}
        </>
      ) : (
        <PanelNavigationContext.Provider value={navigationHost}>
          <PanelContextContext.Provider value={contextHost}>
          {/* Each corner is a button group. Groups wrap without clipping their
              controls, and the content inset follows the measured chrome height. */}
          <div ref={setChromeElement} className={cn("pointer-events-none absolute left-2 right-2 top-2 z-30 hidden flex-wrap items-start justify-between gap-2 transition-opacity duration-150 group-hover/floating-panel:opacity-100 group-focus-within/floating-panel:opacity-100 md:flex", managed && !managed.floating ? "opacity-100" : "opacity-0")}>
            <ButtonGroup
              label="Panel navigation and options"
              floating
              className="pointer-events-auto min-w-0"
            >
            {/* The grip and the panel's mark ARE the first item of this island, not a
                separate pill beside it. Two surfaces read as two groups and cost the gap
                between them; one reads as "where you are" and spends that width on tabs.
                No name here: the panel is identified by its mark and by the tab that is
                lit, and a word set in uppercase tracking was the widest thing in the
                corner while being the one thing you never click. It stays where it is the
                only identity there is — the collapsed pill and the mobile header. */}
            <div
              {...(managed?.dragProps ?? drag.handleProps)}
              ref={setTitleElement}
              data-floating-panel-handle=""
              data-floating-panel-title=""
              className="pointer-events-auto flex h-7 flex-shrink-0 cursor-grab select-none items-center rounded-sm px-1 text-content-subtle active:cursor-grabbing"
              aria-label={`${title} — drag to move`}
            >
              {/* The grip alone. The panel's mark went the way its name did: a panel whose
                  content is a file tree or a plan already says what it is, and in a corner
                  that is capped, an icon you never click is width taken from the tabs. The
                  mark stays where it earns its place — the collapsed pill and the mobile
                  header, where there is no content to say it for you. */}
              <GripHorizontal className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            </div>
            <div
              ref={setNavigationTarget}
              data-floating-panel-navigation=""
              className="pointer-events-auto flex min-w-0 max-w-full flex-wrap items-center gap-1"
            >
              {primaryNavigation && (
                <div data-floating-panel-primary-navigation="" className="min-w-0 max-w-full shrink-0">
                  <AdaptiveControlGroup
                    kind="navigation"
                    ariaLabel={primaryNavigation.ariaLabel}
                    items={primaryNavigation.items}
                    availableWidth={navigationSlotWidth}
                    presentationOrder={primaryNavigation.presentationOrder}
                    collapsedContent={primaryNavigation.collapsedContent}
                  />
                </div>
              )}
              {hasContext && (
                <div
                  data-floating-panel-context=""
                  className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1"
                >
                  {panelContext && <div className="min-w-0 max-w-full">{panelContext}</div>}
                  <div
                    ref={setDesktopContextTarget}
                    className={cn(
                      "min-w-0",
                      portalContextPresent ? "max-w-full" : "hidden"
                    )}
                  />
                </div>
              )}
            </div>
            </ButtonGroup>
            <ButtonGroup
              label="Panel actions"
              floating
              data-floating-panel-actions=""
              className="pointer-events-auto ml-auto"
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
              {managed?.canFloat && <IconButton label={managed.floating ? "Dock panel" : "Float panel"} onClick={managed.toggleFloating}>{managed.floating ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}</IconButton>}
              {!managed && <ActionButton
                action="collapse"
                context="disclosure"
                onClick={toggleCollapsed}
                accessibleLabel="Minimize panel"
                controlSize="compact"
                className="text-content-primary hover:bg-zinc-800 hover:text-content-strong"
              />}
              <ActionButton
                action="close"
                context="windowChrome"
                onClick={onClose}
                accessibleLabel="Close panel"
                controlSize="compact"
                className="text-content-primary hover:bg-zinc-800 hover:text-content-strong"
              />
            </ButtonGroup>
          </div>

          <div
            {...(managed?.dragProps ?? drag.handleProps)}
            data-floating-panel-handle=""
            className="flex min-h-11 flex-shrink-0 flex-wrap cursor-grab select-none items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/35 px-3 active:cursor-grabbing md:hidden"
          >
            <GripHorizontal className="h-4 w-4 flex-shrink-0 text-content-subtle" aria-hidden="true" />
            {titleLabel}
            <div className="flex-1" />
            <ButtonGroup label="Panel actions" controlSize="compact" className="ml-auto">
            <AdaptiveControlGroup kind="actions" ariaLabel="Panel actions" items={allPanelActions} presentationOrder={["icon", "collapsed"]} />
            <ActionButton
              action="close"
              context="windowChrome"
              onClick={onClose}
              accessibleLabel="Close panel"
              controlSize="compact"
              className="text-content-primary hover:bg-zinc-800 hover:text-content-strong"
            />
            </ButtonGroup>
          </div>
          {hasContext && (
            <ButtonGroup label="Panel options" floating
              data-floating-panel-context=""
              className="pointer-events-auto relative z-30 mx-3 mt-2 md:hidden"
            >
              {panelContext && <div className="pointer-events-auto min-w-0 flex-1">{panelContext}</div>}
              <div
                ref={setMobileContextTarget}
                className={cn(
                  "pointer-events-auto min-w-0",
                  portalContextPresent ? "max-w-full" : "hidden"
                )}
              />
            </ButtonGroup>
          )}
          <PanelActionContext.Provider value={registerPortalAction}>
            <div
              data-floating-panel-content=""
              className={cn(
                // Reserve the measured height when button groups wrap.
                "relative flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3 md:absolute md:inset-x-0 md:bottom-0 md:top-[var(--floating-panel-chrome-top)]",
                bodyClassName
              )}
            >
              {children}
            </div>
          </PanelActionContext.Provider>
          {!isMobile && (!managed || managed.floating) && <ResizeGrip resizeProps={managed?.resizeProps ?? drag.resizeProps} />}
          </PanelContextContext.Provider>
        </PanelNavigationContext.Provider>
      )}
    </div>
  );
}
