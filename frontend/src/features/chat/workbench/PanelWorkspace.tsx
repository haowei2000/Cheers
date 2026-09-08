import {
  subscribeLayoutReset,
  type SharedWorkspaceLayout,
} from "./sharedLayout";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, Columns2, Rows2 } from "lucide-react";
import { ButtonGroup } from "@/components/ui/button-group";
import { IconButton } from "@/components/ui/icon-button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import type { SpawnKind } from "./laneSnap";
import {
  parseLocalWorkspacePreference,
  resolveWorkspaceLayout,
} from "./panelWorkspaceLayout";

type Geometry = { x: number; y: number; w: number; h: number };
interface ManagedPanel {
  floating: boolean;
  canFloat: boolean;
  toFront: () => void;
  visible: boolean;
  style: CSSProperties;
  toggleFloating: () => void;
  dragProps: {
    onPointerDown: (event: ReactPointerEvent) => void;
    style: CSSProperties;
  };
  resizeProps: {
    onPointerDown: (event: ReactPointerEvent) => void;
    style: CSSProperties;
  };
}
const WorkspaceContext = createContext<
  ((kind: SpawnKind) => ManagedPanel) | null
>(null);
export function useManagedPanel(kind?: SpawnKind, viewport?: boolean) {
  const get = useContext(WorkspaceContext);
  return kind && !viewport && get ? get(kind) : null;
}

export function PanelWorkspace({
  channelId,
  openPanels,
  panels,
  children,
  onLaneElement,
  revealMessageKey,
  activationRequest,
  sharedLayout,
  onLayoutChange,
}: {
  sharedLayout?: SharedWorkspaceLayout;
  onLayoutChange?: (state: {
    layout: SharedWorkspaceLayout;
    overridden: boolean;
  }) => void;
  channelId: string;
  openPanels: { id: SpawnKind; label: string }[];
  panels: ReactNode;
  children: ReactNode;
  onLaneElement: (element: HTMLElement | null) => void;
  revealMessageKey?: unknown;
  activationRequest?: { id: SpawnKind; nonce: number } | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const setStage = useCallback(
    (element: HTMLDivElement | null) => {
      stageRef.current = element;
      onLaneElement(element);
    },
    [onLaneElement],
  );
  const [stack, setStack] = useState<SpawnKind[]>([]);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [stageHeight, setStageHeight] = useState(0);
  const [requestedWidth, setRequestedWidth] = useState(400);
  const [overridden, setOverridden] = useState(false);
  const [split, setSplit] = useState(false);
  const [ratio, setRatio] = useState(0.5);
  const [active, setActive] = useState<SpawnKind>(
    openPanels[0]?.id ?? "viewboard",
  );
  const [showWork, setShowWork] = useState(openPanels.length > 0);
  const [floats, setFloats] = useState<Partial<Record<SpawnKind, Geometry>>>(
    {},
  );
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const previousOpen = useRef<SpawnKind[]>([]);
  const messageFocus = useRef<HTMLElement | null>(null);
  const layout = resolveWorkspaceLayout(width, requestedWidth);
  const docked = openPanels.filter((p) => !floats[p.id] || !layout.sideBySide);
  const hasDock = docked.length > 0;
  const effectiveActive = docked.some((p) => p.id === active)
    ? active
    : docked[0]?.id;
  const splitRatio = Math.max(
    244 / Math.max(488, stageHeight),
    Math.min(1 - 244 / Math.max(488, stageHeight), ratio),
  );
  const splitIds =
    split && stageHeight >= 488
      ? [
          effectiveActive,
          docked.find((p) => p.id !== effectiveActive)?.id,
        ].filter(Boolean)
      : [effectiveActive];

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      setWidth(root.clientWidth);
      setHeight(root.clientHeight);
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
    try {
      const saved = parseLocalWorkspacePreference(JSON.parse(
        localStorage.getItem(`cheers.panel-workspace.${channelId}`) ?? "null",
      ));
      setRequestedWidth(saved?.width ?? 400);
      setSplit(saved?.split ?? false);
      setRatio(saved?.ratio ?? 0.5);
      if (saved?.active) setActive(saved.active);
      setOverridden(saved != null);
    } catch {
      setRequestedWidth(400);
      setSplit(false);
      setOverridden(false);
    }
    setFloats({});
    previousOpen.current = [];
  }, [channelId]);
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
          localStorage.removeItem(`cheers.panel-workspace.${channelId}`);
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
    [channelId, sharedLayout, width],
  );
  useEffect(() => {
    if (overridden || !sharedLayout || width <= 0) return;
    try {
      if (localStorage.getItem(`cheers.panel-workspace.${channelId}`)) return;
    } catch {
      /* optional storage */
    }
    setRequestedWidth(sharedLayout.width * width);
    setSplit(sharedLayout.split);
    setRatio(sharedLayout.ratio);
    if (sharedLayout.active) setActive(sharedLayout.active);
  }, [sharedLayout, overridden, width, channelId]);
  useEffect(() => {
    if (width <= 0) return;
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
      overridden: overridden || Object.keys(floats).length > 0,
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
  const remember = (
    nextWidth: number,
    nextSplit: boolean,
    nextRatio = ratio,
    nextActive = active,
  ) => {
    setOverridden(true);
    try {
      localStorage.setItem(
        `cheers.panel-workspace.${channelId}`,
        JSON.stringify({
          width: nextWidth,
          split: nextSplit,
          ratio: nextRatio,
          active: nextActive,
        }),
      );
    } catch {
      /* optional local preference */
    }
  };
  const trackPointer = (
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
  };
  const dock = (id: SpawnKind) => {
    setFloats((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setActive(id);
    setShowWork(true);
  };
  const initialGeometry = (): Geometry => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (typeof window === "undefined") return { x: 8, y: 80, w: 420, h: 600 };
    return {
      x: Math.max(8, Math.min(rect?.left ?? 80, window.innerWidth - 428)),
      y: 80,
      w: Math.min(420, window.innerWidth - 16),
      h: Math.min(600, window.innerHeight - 96),
    };
  };
  const getPanel = (id: SpawnKind): ManagedPanel => {
    const floating = Boolean(floats[id]) && layout.sideBySide;
    const geometry = floats[id] ?? initialGeometry();
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
      style: floating
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
      toggleFloating: () =>
        floating
          ? dock(id)
          : setFloats((current) => ({ ...current, [id]: initialGeometry() })),
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
            ? geometry
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
            },
          );
        },
      },
      resizeProps: {
        style: { touchAction: "none" },
        onPointerDown: (event) => {
          const x = event.clientX;
          const y = event.clientY;
          trackPointer(event, (next) =>
            setFloats((current) => ({
              ...current,
              [id]: {
                ...geometry,
                w: Math.max(320, geometry.w + next.clientX - x),
                h: Math.max(240, geometry.h + next.clientY - y),
              },
            })),
          );
        },
      },
    };
  };
  return (
    <WorkspaceContext.Provider value={getPanel}>
      <div
        ref={rootRef}
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
              className="w-2 shrink-0 cursor-col-resize touch-none bg-zinc-800/30 focus-visible:bg-zinc-700"
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
            className="flex min-h-0 shrink-0 flex-col bg-zinc-900/40"
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
                {docked.length > 1 && height >= 520 && (
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
                  className="absolute inset-x-0 z-10 h-2 cursor-row-resize touch-none bg-zinc-800/40"
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
    </WorkspaceContext.Provider>
  );
}
