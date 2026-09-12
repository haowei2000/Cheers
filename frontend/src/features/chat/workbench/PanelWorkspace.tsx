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
import { ArrowLeft, Columns2, Rows2 } from "lucide-react";
import { ButtonGroup } from "@/components/ui/button-group";
import { IconButton } from "@/components/ui/icon-button";
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
    setFloats((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    remember(requestedWidth, split, ratio, id);
    setActive(id);
    setShowWork(true);
  }, [ratio, remember, requestedWidth, setFloats, split]);
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
      dragProps: {
        style: { touchAction: "none", cursor: "grab" },
        onPointerDown: (event) => {
          if (
            !layout.sideBySide ||
            (event.target as HTMLElement).closest(
              "button,input,select,textarea,a",
            )
          )
            return;
          const startX = event.clientX;
          const startY = event.clientY;
          const panelRect = (event.currentTarget as HTMLElement)
            .closest("[data-floating-panel]")
            ?.getBoundingClientRect();
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
              setFloats((current) => ({
                ...current,
                [id]: {
                  ...origin,
                  x: origin.x + next.clientX - startX,
                  y: origin.y + next.clientY - startY,
                },
              }));
            },
            (next) => {
              if (!moved) return;
              const root = rootRef.current?.getBoundingClientRect();
              if (
                root &&
                next.clientX > root.right - 96 &&
                next.clientX <= root.right &&
                next.clientY >= root.top &&
                next.clientY <= root.bottom
              )
                dock(id);
              else
                remember(requestedWidth, split);
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
    floats,
    hasDock,
    initialGeometry,
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
            label="Conversation view"
            controlSize="regular"
            className="shrink-0 px-3 py-1"
          >
            <ControlTrigger selected={!showWork} onClick={showMessages}>
              Messages
            </ControlTrigger>
            <ControlTrigger
              selected={showWork}
              onClick={() => setShowWork(true)}
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
            className="flex min-w-0 flex-1 flex-col"
            style={{
              display:
                !layout.sideBySide && hasDock && showWork ? "none" : undefined,
            }}
          >
            {children}
          </div>
          {layout.sideBySide && hasDock && (
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
            className="flex min-h-0 shrink-0 flex-col bg-panel/40"
            style={{
              width: hasDock
                ? layout.sideBySide
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
                className="shrink-0 flex-wrap p-1"
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
          <div className="pointer-events-none absolute inset-y-0 right-0 z-50 flex w-24 items-center justify-center rounded-sm bg-indigo-500/20 text-compact text-content-primary">
            Dock here
          </div>
        )}
      </div>
    </ManagedPanelProvider>
  );
}
