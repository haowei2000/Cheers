import {
  subscribeLayoutReset,
  type SharedWorkspaceLayout,
} from "./sharedLayout";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, Columns2, PanelRightClose, Rows2 } from "lucide-react";
import { ButtonGroup } from "@/components/ui/button-group";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/cn";
import {
  ManagedPanelProvider,
  type ManagedPanel,
} from "@/components/ui/managed-panel";
import { ControlTrigger } from "@/components/ui/control-trigger";
import type { Rect, SpawnKind } from "./laneSnap";
import {
  canSplitWorkspace,
  restoreLocalWorkspacePreference,
  resolveWorkspaceLayout,
  toLaneRelativeRect,
  toViewportRect,
  workspacePreferenceKey,
} from "./panelWorkspaceLayout";

type Geometry = Rect;

export function PanelWorkspace({
  channelId,
  openPanels,
  panels,
  children,
  onLaneElement,
  revealMessageKey,
  activationRequest,
  sharedLayout,
  sharedGeometryFor,
  onLayoutChange,
}: {
  sharedLayout?: SharedWorkspaceLayout;
  sharedGeometryFor?: (kind: SpawnKind) => Rect | null;
  onLayoutChange?: (state: {
    layout: SharedWorkspaceLayout;
    overridden: boolean;
    floatingPanels: Partial<Record<SpawnKind, Rect>>;
  }) => void;
  channelId: string;
  openPanels: { id: SpawnKind; label: string }[];
  panels: ReactNode;
  children: ReactNode;
  onLaneElement: (element: HTMLElement | null) => void;
  revealMessageKey?: unknown;
  activationRequest?: { id: SpawnKind; nonce: number } | null;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const setRoot = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      onLaneElement(element);
    },
    [onLaneElement],
  );
  const setStage = useCallback(
    (element: HTMLDivElement | null) => {
      stageRef.current = element;
    },
    [],
  );
  const [stack, setStack] = useState<SpawnKind[]>([]);
  const [width, setWidth] = useState(0);
  const [stageHeight, setStageHeight] = useState(0);
  const [requestedWidth, setRequestedWidth] = useState(400);
  const [overridden, setOverridden] = useState(false);
  const [split, setSplit] = useState(false);
  const [ratio, setRatio] = useState(0.5);
  const [active, setActive] = useState<SpawnKind>(
    openPanels[0]?.id ?? "viewboard",
  );
  const [showWork, setShowWork] = useState(openPanels.length > 0);
  const [expanded, setExpanded] = useState(false);
  const [floats, setFloatsState] = useState<Partial<Record<SpawnKind, Geometry>>>(
    {},
  );
  const floatsRef = useRef<Partial<Record<SpawnKind, Geometry>>>({});
  const setFloats = useCallback(
    (update: SetStateAction<Partial<Record<SpawnKind, Geometry>>>) => {
      const next = typeof update === "function" ? update(floatsRef.current) : update;
      floatsRef.current = next;
      setFloatsState(next);
    },
    [],
  );
  const [dragging, setDragging] = useState(false);
  const [isOverDock, setIsOverDock] = useState(false);
  const [restoredChannel, setRestoredChannel] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const previousOpen = useRef<SpawnKind[]>([]);
  const openPanelsRef = useRef(openPanels);
  openPanelsRef.current = openPanels;
  const openPanelKey = openPanels.map((panel) => panel.id).join(",");
  const messageFocus = useRef<HTMLElement | null>(null);
  const layout = resolveWorkspaceLayout(width, requestedWidth);
  const docked = useMemo(
    () => openPanels.filter((panel) => !floats[panel.id] || !layout.sideBySide),
    [floats, layout.sideBySide, openPanels],
  );
  const hasDock = docked.length > 0;
  const effectiveActive = docked.some((p) => p.id === active)
    ? active
    : docked[0]?.id;
  const splitRatio = Math.max(
    244 / Math.max(488, stageHeight),
    Math.min(1 - 244 / Math.max(488, stageHeight), ratio),
  );
  const splitIds = useMemo(
    () =>
      split && stageHeight >= 488
        ? [
            effectiveActive,
            docked.find((panel) => panel.id !== effectiveActive)?.id,
          ].filter(Boolean)
        : [effectiveActive],
    [docked, effectiveActive, split, stageHeight],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      setWidth(root.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(() => {
      measure();
      setStageHeight(stageRef.current?.clientHeight ?? 0);
    });
    observer.observe(root);
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => cleanupRef.current?.(), []);
  useEffect(() => {
    const channelPanels = openPanelsRef.current;
    const fallbackActive = channelPanels[0]?.id ?? "viewboard";
    cleanupRef.current?.();
    cleanupRef.current = null;
    try {
      const restored = restoreLocalWorkspacePreference(
        localStorage.getItem(workspacePreferenceKey(channelId)),
        fallbackActive,
      );
      setRequestedWidth(restored.width);
      setSplit(restored.split);
      setRatio(restored.ratio);
      setActive(restored.active ?? fallbackActive);
      setOverridden(restored.overridden);
      const lane = rootRef.current?.getBoundingClientRect();
      setFloats(
        lane
          ? Object.fromEntries(
              Object.entries(restored.floats).map(([id, rect]) => [
                id,
                toViewportRect(rect!, lane),
              ]),
            )
          : {},
      );
    } catch {
      setRequestedWidth(400);
      setSplit(false);
      setRatio(0.5);
      setActive(fallbackActive);
      setOverridden(false);
      setFloats({});
    }
    setShowWork(channelPanels.length > 0);
    setExpanded(false);
    setStack([]);
    setDragging(false);
    previousOpen.current = [];
    setRestoredChannel(channelId);
  }, [channelId, setFloats]);
  useEffect(() => {
    const added = openPanels.filter(
      (p) => !previousOpen.current.includes(p.id),
    );
    if (added.length) {
      setActive((current) =>
        added.some((panel) => panel.id === current)
          ? current
          : added.at(-1)!.id,
      );
      setShowWork(true);
    }
    if (previousOpen.current.length && !openPanels.length)
      requestAnimationFrame(
        () =>
          messageFocus.current?.isConnected &&
          messageFocus.current.focus({ preventScroll: true }),
      );
    previousOpen.current = openPanels.map((p) => p.id);
  }, [openPanels]);
  useEffect(() => {
    if (activationRequest) {
      setActive(activationRequest.id);
      setShowWork(true);
    }
  }, [activationRequest]);
  useEffect(() => {
    if (!layout.sideBySide || !hasDock) setExpanded(false);
  }, [hasDock, layout.sideBySide]);
  const showMessages = useCallback(() => {
    setShowWork(false);
    requestAnimationFrame(() => {
      if (messageFocus.current?.isConnected)
        messageFocus.current.focus({ preventScroll: true });
    });
  }, []);
  useLayoutEffect(() => {
    if (revealMessageKey) showMessages();
  }, [revealMessageKey, showMessages]);
  useEffect(
    () =>
      subscribeLayoutReset(() => {
        try {
          localStorage.removeItem(workspacePreferenceKey(channelId));
        } catch {
          /* optional storage */
        }
        setOverridden(false);
        setFloats({});
        setRequestedWidth(sharedLayout ? sharedLayout.width * width : 400);
        setSplit(sharedLayout?.split ?? false);
        setRatio(sharedLayout?.ratio ?? 0.5);
        if (sharedLayout?.active) setActive(sharedLayout.active);
      }),
    [channelId, setFloats, sharedLayout, width],
  );
  useEffect(() => {
    if (overridden || !sharedLayout || width <= 0) return;
    try {
      if (localStorage.getItem(workspacePreferenceKey(channelId))) return;
    } catch {
      /* optional storage */
    }
    setRequestedWidth(sharedLayout.width * width);
    setSplit(sharedLayout.split);
    setRatio(sharedLayout.ratio);
    if (sharedLayout.active) setActive(sharedLayout.active);
  }, [sharedLayout, overridden, width, channelId]);
  useEffect(() => {
    if (
      restoredChannel !== channelId ||
      overridden ||
      !layout.sideBySide ||
      !sharedGeometryFor
    )
      return;
    const lane = rootRef.current?.getBoundingClientRect();
    if (!lane || lane.width <= 0 || lane.height <= 0) return;
    const next: Partial<Record<SpawnKind, Geometry>> = {};
    for (const panel of openPanelsRef.current) {
      const rect = sharedGeometryFor(panel.id);
      if (rect) next[panel.id] = toViewportRect(rect, lane);
    }
    setFloats((current) => {
      const ids = Object.keys(next) as SpawnKind[];
      if (
        ids.length === Object.keys(current).length &&
        ids.every((id) => {
          const a = current[id];
          const b = next[id];
          return a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
        })
      )
        return current;
      return next;
    });
  }, [
    channelId,
    layout.sideBySide,
    openPanelKey,
    overridden,
    restoredChannel,
    setFloats,
    sharedGeometryFor,
    stageHeight,
    width,
  ]);
  useEffect(() => {
    if (width <= 0) return;
    const lane = rootRef.current?.getBoundingClientRect();
    const floatingPanels: Partial<Record<SpawnKind, Rect>> = {};
    if (lane) {
      for (const [id, rect] of Object.entries(floats)) {
        if (rect) floatingPanels[id as SpawnKind] = toLaneRelativeRect(rect, lane);
      }
    }
    onLayoutChange?.({
      layout: {
        width: Math.min(
          1,
          (layout.sideBySide ? layout.panelWidth : requestedWidth) / width,
        ),
        split,
        ratio,
        active,
      },
      overridden,
      floatingPanels,
    });
  }, [
    width,
    requestedWidth,
    layout.sideBySide,
    layout.panelWidth,
    split,
    ratio,
    active,
    overridden,
    floats,
    onLayoutChange,
  ]);
  const remember = useCallback((
    nextWidth: number,
    nextSplit: boolean,
    nextRatio = ratio,
    nextActive = active,
    nextFloats = floatsRef.current,
  ) => {
    setOverridden(true);
    const lane = rootRef.current?.getBoundingClientRect();
    const storedFloats: Partial<Record<SpawnKind, Rect>> = {};
    if (lane) {
      for (const [id, rect] of Object.entries(nextFloats)) {
        if (rect) storedFloats[id as SpawnKind] = toLaneRelativeRect(rect, lane);
      }
    }
    try {
      localStorage.setItem(
        workspacePreferenceKey(channelId),
        JSON.stringify({
          width: nextWidth,
          split: nextSplit,
          ratio: nextRatio,
          active: nextActive,
          floats: storedFloats,
        }),
      );
    } catch {
      /* optional local preference */
    }
  }, [active, channelId, ratio]);
  const trackPointer = useCallback((
    event: ReactPointerEvent,
    move: (event: PointerEvent) => void,
    end?: (event: PointerEvent) => void,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanupRef.current?.();
    const onMove = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) move(next);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onCancel);
      setDragging(false);
      setIsOverDock(false);
    };
    const onEnd = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) {
        end?.(next);
        cleanup();
      }
    };
    const onCancel = () => cleanup();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onCancel);
    cleanupRef.current = cleanup;
  }, []);
  const dock = useCallback((id: SpawnKind) => {
    const next = { ...floatsRef.current };
    delete next[id];
    setFloats(next);
    remember(requestedWidth, split, ratio, id, next);
    setActive(id);
    setShowWork(true);
  }, [ratio, remember, requestedWidth, setFloats, split]);
  const isDockZone = useCallback((
    clientX: number,
    clientY: number,
    panelRect?: { right: number; left: number; width: number },
  ): boolean => {
    const root = rootRef.current?.getBoundingClientRect();
    if (!root) return false;

    // Generous vertical tolerance covers full height of window
    const isVerticalInRange =
      clientY >= root.top - 80 && clientY <= root.bottom + 80;
    if (!isVerticalInRange) return false;

    // Case 1: Cursor is within 140px of root right (or even past root right on the edge)
    const isCursorInDock =
      clientX >= root.right - 140 && clientX <= root.right + 100;
    if (isCursorInDock) return true;

    // Case 2: Panel's right edge or center is in the dock zone
    if (panelRect) {
      if (panelRect.right >= root.right - 80) return true;
      if (panelRect.left + panelRect.width / 2 >= root.right - 240) return true;
    }

    return false;
  }, []);
  const initialGeometry = useCallback((): Geometry => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (typeof window === "undefined") return { x: 8, y: 80, w: 420, h: 600 };
    return {
      x: Math.max(8, Math.min(rect?.left ?? 80, window.innerWidth - 428)),
      y: 80,
      w: Math.min(420, window.innerWidth - 16),
      h: Math.min(600, window.innerHeight - 96),
    };
  }, []);
  const getPanel = useCallback((rawId: string): ManagedPanel => {
    const id = rawId as SpawnKind;
    const geometry = floats[id];
    const floating = Boolean(geometry) && layout.sideBySide;
    const slot = splitIds.indexOf(id);
    return {
      floating,
      canFloat: layout.sideBySide,
      expanded,
      canExpand: layout.sideBySide && !floating,
      toFront: () =>
        setStack((current) =>
          current.at(-1) === id
            ? current
            : [...current.filter((item) => item !== id), id],
        ),
      visible:
        floating || (hasDock && (layout.sideBySide || showWork) && slot >= 0),
      style: floating && geometry
        ? {
            position: "fixed",
            left: Math.max(
              8,
              Math.min(
                geometry.x,
                window.innerWidth -
                  Math.min(geometry.w, window.innerWidth - 16) -
                  8,
              ),
            ),
            top: Math.max(
              8,
              Math.min(
                geometry.y,
                window.innerHeight -
                  Math.min(geometry.h, window.innerHeight - 16) -
                  8,
              ),
            ),
            width: Math.min(geometry.w, window.innerWidth - 16),
            height: Math.min(geometry.h, window.innerHeight - 16),
            zIndex: 40 + Math.max(0, stack.indexOf(id)),
          }
        : {
            position: "absolute",
            left: 0,
            right: 0,
            top: slot === 1 ? `calc(${splitRatio * 100}% + 4px)` : 0,
            bottom:
              slot === 0 && splitIds.length === 2
                ? `calc(${(1 - splitRatio) * 100}% + 4px)`
                : 0,
            width: "100%",
            height: "auto",
            zIndex: 1,
          },
      toggleFloating: () => {
        if (floating) {
          dock(id);
          return;
        }
        setFloats((current) => ({ ...current, [id]: initialGeometry() }));
        remember(requestedWidth, split);
      },
      toggleExpanded: () => {
        if (floating) return;
        setActive(id);
        setShowWork(true);
        setExpanded((current) => !current);
      },
      dragProps: {
        style: { touchAction: "none", cursor: "grab" },
        onPointerDown: (event) => {
          if (
            !layout.sideBySide ||
            (event.target as HTMLElement).closest(
              "button,input,select,textarea,a,[role='button'],[role='tab']",
            )
          )
            return;
          const startX = event.clientX;
          const startY = event.clientY;
          const panelEl = (event.currentTarget as HTMLElement).closest(
            "[data-floating-panel]",
          ) as HTMLElement | null;
          const panelRect = panelEl?.getBoundingClientRect();
          const origin = floating
            ? geometry!
            : panelRect
              ? {
                  x: panelRect.left,
                  y: panelRect.top,
                  w: panelRect.width,
                  h: panelRect.height,
                }
              : initialGeometry();
          let moved = false;
          const lastPos = { x: origin.x, y: origin.y };
          const lastDock = { current: false };
          trackPointer(
            event,
            (next) => {
              if (
                !moved &&
                Math.hypot(next.clientX - startX, next.clientY - startY) < 6
              )
                return;
              moved = true;
              setOverridden(true);
              setDragging(true);
              if (panelEl) {
                panelEl.dataset.dragging = "true";
              }
              const rawX = origin.x + next.clientX - startX;
              const rawY = origin.y + next.clientY - startY;
              const root = rootRef.current?.getBoundingClientRect();

              // Check if cursor or panel is in dock zone
              const inDock = isDockZone(next.clientX, next.clientY, {
                right: rawX + origin.w,
                left: rawX,
                width: origin.w,
              });
              lastDock.current = inDock;
              setIsOverDock(inDock);

              // Sticky-note edge snapping
              let nextX = rawX;
              let nextY = rawY;
              let isSnapped = inDock;
              if (root) {
                const margin = 8;
                const snapThreshold = 24;
                const minX = root.left + margin;
                const maxX = root.right - origin.w - margin;
                const minY = root.top + margin;
                const maxY = root.bottom - origin.h - margin;

                if (inDock) {
                  // Magnetically snap into dock edge
                  nextX = maxX;
                  isSnapped = true;
                } else if (Math.abs(rawX - minX) <= snapThreshold) {
                  nextX = minX;
                  isSnapped = true;
                } else if (Math.abs(rawX - maxX) <= snapThreshold) {
                  nextX = maxX;
                  isSnapped = true;
                }

                if (Math.abs(rawY - minY) <= snapThreshold) {
                  nextY = minY;
                  isSnapped = true;
                } else if (Math.abs(rawY - maxY) <= snapThreshold) {
                  nextY = maxY;
                  isSnapped = true;
                }
              }

              lastPos.x = nextX;
              lastPos.y = nextY;

              if (panelEl) {
                if (isSnapped) panelEl.dataset.snapped = "true";
                else delete panelEl.dataset.snapped;
              }

              setFloats((current) => ({
                ...current,
                [id]: {
                  ...origin,
                  x: nextX,
                  y: nextY,
                },
              }));
            },
            (next) => {
              if (panelEl) {
                delete panelEl.dataset.dragging;
                delete panelEl.dataset.snapped;
              }
              setIsOverDock(false);
              if (!moved) return;

              const shouldDock =
                lastDock.current ||
                isDockZone(next.clientX, next.clientY, {
                  right: lastPos.x + origin.w,
                  left: lastPos.x,
                  width: origin.w,
                });

              if (shouldDock) {
                dock(id);
              } else {
                remember(requestedWidth, split);
              }
            },
          );
        },
      },
      resizeProps: {
        style: { touchAction: "none" },
        onPointerDown: (event) => {
          const origin = geometry ?? initialGeometry();
          const x = event.clientX;
          const y = event.clientY;
          trackPointer(
            event,
            (next) =>
              setFloats((current) => ({
                ...current,
                [id]: {
                  ...origin,
                  w: Math.max(320, origin.w + next.clientX - x),
                  h: Math.max(240, origin.h + next.clientY - y),
                },
              })),
            () => remember(requestedWidth, split),
          );
        },
      },
    };
  }, [
    dock,
    expanded,
    floats,
    hasDock,
    initialGeometry,
    isDockZone,
    layout.sideBySide,
    showWork,
    splitIds,
    splitRatio,
    stack,
    trackPointer,
    remember,
    requestedWidth,
    setFloats,
    split,
  ]);
  return (
    <ManagedPanelProvider resolve={getPanel}>
      <div
        ref={setRoot}
        data-panel-workspace=""
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {!layout.sideBySide && hasDock && (
          <ButtonGroup
            role="tablist"
            label="Conversation view"
            controlSize="regular"
            className="shrink-0 border-b border-control/80 px-3 py-1"
          >
            <ControlTrigger
              role="tab"
              selected={!showWork}
              onClick={showMessages}
              className={cn(
                "rounded-none border-b-2 bg-transparent ring-0 shadow-none -mb-px hover:bg-transparent",
                !showWork
                  ? "border-content-strong text-content-strong font-semibold"
                  : "border-transparent text-content-primary hover:text-content-strong",
              )}
            >
              Messages
            </ControlTrigger>
            <ControlTrigger
              role="tab"
              selected={showWork}
              onClick={() => setShowWork(true)}
              className={cn(
                "rounded-none border-b-2 bg-transparent ring-0 shadow-none -mb-px hover:bg-transparent",
                showWork
                  ? "border-content-strong text-content-strong font-semibold"
                  : "border-transparent text-content-primary hover:text-content-strong",
              )}
            >
              Workspace
            </ControlTrigger>
          </ButtonGroup>
        )}
        <div className="relative flex min-h-0 flex-1">
          <div
            data-workspace-messages=""
            onFocusCapture={(event) => {
              messageFocus.current = event.target as HTMLElement;
            }}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            style={{
              display:
                expanded || (!layout.sideBySide && hasDock && showWork) ? "none" : undefined,
            }}
          >
            {children}
          </div>
          {layout.sideBySide && hasDock && !expanded && (
            <div
              role="separator"
              aria-label="Resize workspace"
              aria-orientation="vertical"
              aria-valuemin={320}
              aria-valuemax={Math.max(320, width - 488)}
              aria-valuenow={Math.round(layout.panelWidth)}
              tabIndex={0}
              className="w-2 shrink-0 cursor-col-resize touch-none bg-control/30 focus-visible:bg-control-hover"
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 320
                    : event.key === "End"
                      ? width - 488
                      : layout.panelWidth +
                        (event.key === "ArrowLeft" ? 24 : -24);
                const clamped = resolveWorkspaceLayout(width, next).panelWidth;
                setRequestedWidth(clamped);
                remember(clamped, split);
              }}
              onPointerDown={(event) => {
                const right = rootRef.current!.getBoundingClientRect().right;
                trackPointer(
                  event,
                  (next) =>
                    setRequestedWidth(
                      resolveWorkspaceLayout(width, right - next.clientX)
                        .panelWidth,
                    ),
                  (next) =>
                    remember(
                      resolveWorkspaceLayout(width, right - next.clientX)
                        .panelWidth,
                      split,
                    ),
                );
              }}
            />
          )}
          <aside
            data-workspace-dock=""
            data-workspace-expanded={expanded || undefined}
            className={cn(
              "flex min-h-0 shrink-0 flex-col bg-panel",
              !expanded && "border-l border-control/80",
            )}
            style={{
              width: hasDock
                ? expanded
                  ? "100%"
                  : layout.sideBySide
                  ? layout.panelWidth
                  : "100%"
                : 0,
              display:
                !layout.sideBySide && hasDock && !showWork ? "none" : undefined,
            }}
          >
            {hasDock && (
              <ButtonGroup
                label="Workspace panels"
                controlSize="compact"
                className="shrink-0 flex-wrap border-b border-control/80 bg-panel px-2 py-1"
              >
                {!layout.sideBySide && (
                  <IconButton label="Back to messages" onClick={showMessages}>
                    <ArrowLeft className="h-4 w-4" />
                  </IconButton>
                )}
                {docked.map((panel) => (
                  <ControlTrigger
                    key={panel.id}
                    selected={effectiveActive === panel.id}
                    onClick={() => {
                      setActive(panel.id);
                      remember(requestedWidth, split, ratio, panel.id);
                    }}
                    role="tab"
                    className={cn(
                      "rounded-none border-b-2 bg-transparent shadow-none ring-0",
                      effectiveActive === panel.id
                        ? "border-content-strong text-content-strong font-semibold"
                        : "border-transparent text-content-primary hover:text-content-strong hover:bg-transparent"
                    )}
                  >
                    {panel.label}
                  </ControlTrigger>
                ))}
                {canSplitWorkspace(stageHeight, docked.length) && (
                  <IconButton
                    label={split ? "Use panel tabs" : "Split panels vertically"}
                    aria-pressed={split}
                    onClick={() => {
                      setSplit(!split);
                      remember(requestedWidth, !split);
                    }}
                  >
                    {split ? (
                      <Columns2 className="h-4 w-4" />
                    ) : (
                      <Rows2 className="h-4 w-4" />
                    )}
                  </IconButton>
                )}
              </ButtonGroup>
            )}
            <div ref={setStage} className="relative min-h-0 flex-1">
              {panels}
              {splitIds.length === 2 && (
                <div
                  role="separator"
                  aria-label="Resize panel split"
                  aria-orientation="horizontal"
                  aria-valuemin={Math.ceil(
                    (244 / Math.max(488, stageHeight)) * 100,
                  )}
                  aria-valuemax={Math.floor(
                    (1 - 244 / Math.max(488, stageHeight)) * 100,
                  )}
                  aria-valuenow={Math.round(splitRatio * 100)}
                  tabIndex={0}
                  className="absolute inset-x-0 z-10 h-2 cursor-row-resize touch-none bg-control/40"
                  style={{ top: `calc(${splitRatio * 100}% - 4px)` }}
                  onKeyDown={(event) => {
                    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
                    event.preventDefault();
                    const nextRatio = Math.max(
                      0.25,
                      Math.min(
                        0.75,
                        splitRatio + (event.key === "ArrowDown" ? 0.05 : -0.05),
                      ),
                    );
                    setRatio(nextRatio);
                    remember(requestedWidth, split, nextRatio);
                  }}
                  onPointerDown={(event) => {
                    const rect = stageRef.current!.getBoundingClientRect();
                    const value = (next: PointerEvent) =>
                      Math.max(
                        0.25,
                        Math.min(0.75, (next.clientY - rect.top) / rect.height),
                      );
                    trackPointer(
                      event,
                      (next) => setRatio(value(next)),
                      (next) => remember(requestedWidth, split, value(next)),
                    );
                  }}
                />
              )}
            </div>
          </aside>
        </div>
        {dragging && (
          <div
            className={cn(
              "pointer-events-none absolute inset-y-0 right-0 z-50 flex w-28 items-center justify-center rounded-l-sm border-l-2 text-compact font-medium transition-all duration-150",
              isOverDock
                ? "border-content-strong bg-selected/80 text-content-strong shadow-md"
                : "border-control/60 bg-panel/80 text-content-secondary",
            )}
          >
            <div className="flex flex-col items-center gap-1 px-2 text-center">
              <PanelRightClose
                className={cn(
                  "h-5 w-5 transition-transform duration-150",
                  isOverDock && "scale-110 text-content-strong",
                )}
              />
              <span className="font-semibold tracking-tight">
                {isOverDock ? "Release to dock" : "Dock here"}
              </span>
            </div>
          </div>
        )}
      </div>
    </ManagedPanelProvider>
  );
}
