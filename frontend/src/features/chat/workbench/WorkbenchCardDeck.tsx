import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Code2,
  FileCode,
  FileText,
  LayoutGrid,
  ListTree,
  Lock,
  Table,
} from "lucide-react";
import { useContextSurface } from "@/components/ui/context-actions";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { cn } from "@/lib/cn";
import { AddContextIcon, TabIcon } from "@/components/ui/editorial-icons";
import { PresenceDot } from "@/components/ui/presence-dot";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface WorkbenchCardItem {
  path: string;
  label: string;
  isDirty?: boolean;
  hasError?: boolean;
  hasContext?: boolean;
  noteCount?: number;
  rendererId?: string;
  rendererTitle?: string;
  previewSnippet?: string;
}

interface Props {
  tabs: WorkbenchCardItem[];
  selectedPath: string | null;
  onSelectTab: (path: string) => void;
  renderActiveCardContent: (path: string) => ReactNode;
  onAddToContext?: (path: string) => void;
  isLocked?: boolean;
  shakeNonce?: number;
  onLockedAttempt?: () => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  className?: string;
}

function iconForPath(path: string, rendererId?: string) {
  if (rendererId?.includes("kanban")) return LayoutGrid;
  if (rendererId?.includes("table")) return Table;
  if (rendererId?.includes("codemap")) return ListTree;
  if (/\.(ts|tsx|js|jsx|rs|go|py|c|cpp|h)$/i.test(path)) return FileCode;
  if (/\.(json|ya?ml|toml)$/i.test(path)) return Code2;
  if (/\.(md|markdown|txt|org)$/i.test(path)) return FileText;
  return TabIcon;
}

function extensionOf(path: string) {
  const file = path.split("/").pop() || path;
  const dot = file.lastIndexOf(".");
  return dot >= 0 ? file.slice(dot) : "";
}

function InactiveCardTitle({ tab, onSelect, onAddToContext }: {
  tab: WorkbenchCardItem;
  onSelect: () => void;
  onAddToContext?: (path: string) => void;
}) {
  const surfaceRef = useRef<HTMLButtonElement>(null);
  const context = useContextSurface({ surfaceRef, actions: () => onAddToContext ? [{
    id: "add-context", label: tab.hasContext ? "Already added to context" : "Add to context",
    icon: <AddContextIcon className="h-4 w-4" />, disabled: tab.hasContext,
    run: () => onAddToContext(tab.path),
  }] : [] });
  return <ControlTrigger ref={surfaceRef} controlSize="compact" controlWidth="fill"
    onClick={onSelect} aria-label={`Focus ${tab.label}`} className="min-w-0 truncate font-utility text-content-strong"
    onContextMenu={context.onContextMenu} onKeyDown={context.onKeyDown}
    onPointerDown={context.onPointerDown} onPointerMove={context.onPointerMove}
    onPointerUp={context.onPointerUp} onPointerCancel={context.onPointerCancel}>
    {tab.label}
  </ControlTrigger>;
}

export function WorkbenchCardDeck({
  tabs,
  selectedPath,
  onSelectTab,
  renderActiveCardContent,
  onAddToContext,
  isLocked = false,
  shakeNonce,
  onLockedAttempt,
  isMaximized = false,
  onToggleMaximize,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [deckHeight, setDeckHeight] = useState(0);
  const [metrics, setMetrics] = useState<Record<string, { scale: number; opacity: number }>>({});
  const [isShaking, setIsShaking] = useState(false);
  const shakeTimeoutRef = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);
  const isUserScrollingRef = useRef(false);
  const scrollEndTimeoutRef = useRef<number | null>(null);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;

  const triggerShake = useCallback(() => {
    if (!isLocked) return;
    if (shakeTimeoutRef.current !== null) clearTimeout(shakeTimeoutRef.current);
    setIsShaking(true);
    shakeTimeoutRef.current = window.setTimeout(() => {
      setIsShaking(false);
      shakeTimeoutRef.current = null;
    }, 380);
  }, [isLocked]);

  useEffect(() => {
    if (!isLocked) {
      setIsShaking(false);
      if (shakeTimeoutRef.current !== null) {
        clearTimeout(shakeTimeoutRef.current);
        shakeTimeoutRef.current = null;
      }
      return;
    }
    if (shakeNonce && shakeNonce > 0) {
      triggerShake();
    }
  }, [isLocked, shakeNonce, triggerShake]);

  // Listen to wheel events on container when locked to trigger shake without scrolling
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isLocked) return;

    const onWheel = (e: globalThis.WheelEvent) => {
      if (Math.abs(e.deltaY) > 2 || Math.abs(e.deltaX) > 2) {
        e.preventDefault();
        e.stopPropagation();
        triggerShake();
        onLockedAttempt?.();
      }
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [isLocked, onLockedAttempt, triggerShake]);

  const calculateTransforms = useCallback(() => {
    const container = containerRef.current;
    if (!container || tabs.length === 0) return;

    setDeckHeight(container.clientHeight);
    const containerRect = container.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;
    const maxDistance = Math.max(containerRect.height * 0.6, 200);

    const nextMetrics: Record<string, { scale: number; opacity: number }> = {};
    let closestPath = tabs[0].path;
    let closestDist = Infinity;

    for (const tab of tabs) {
      const el = cardRefs.current.get(tab.path);
      if (!el) continue;

      const cardRect = el.getBoundingClientRect();
      const cardCenterY = cardRect.top + cardRect.height / 2;
      const distance = Math.abs(cardCenterY - centerY);

      if (distance < closestDist) {
        closestDist = distance;
        closestPath = tab.path;
      }

      const normalized = Math.min(1, distance / maxDistance);
      // Cosine falloff: 1 at center, decaying to 0
      const factor = Math.cos(normalized * (Math.PI / 2));

      // Magnify closest to center (scale 1.0), scaling down to 0.92 at edges
      const scale = 0.92 + factor * 0.08;
      // Opacity 1.0 at center, down to 0.55 at edges
      const opacity = 0.85 + factor * 0.15;

      nextMetrics[tab.path] = {
        scale: Number(scale.toFixed(3)),
        opacity: Number(opacity.toFixed(3)),
      };
    }

    setMetrics(nextMetrics);
    return closestPath;
  }, [tabs]);

  const handleScroll = useCallback(() => {
    if (isLocked || isMaximized) return;

    isUserScrollingRef.current = true;
    if (scrollEndTimeoutRef.current !== null) {
      clearTimeout(scrollEndTimeoutRef.current);
    }
    scrollEndTimeoutRef.current = window.setTimeout(() => {
      isUserScrollingRef.current = false;
      scrollEndTimeoutRef.current = null;
    }, 150);

    if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => {
      const closest = calculateTransforms();
      if (closest && closest !== selectedPathRef.current) {
        onSelectTab(closest);
      }
      rafId.current = null;
    });
  }, [calculateTransforms, isLocked, isMaximized, onSelectTab]);

  useIsomorphicLayoutEffect(() => {
    calculateTransforms();
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(calculateTransforms);
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      if (shakeTimeoutRef.current !== null) clearTimeout(shakeTimeoutRef.current);
      if (scrollEndTimeoutRef.current !== null) clearTimeout(scrollEndTimeoutRef.current);
    };
  }, [calculateTransforms, tabs.length]);

  // Center selected tab when selection changes externally (not by user scrolling)
  useEffect(() => {
    if (!selectedPath) return;
    if (isUserScrollingRef.current) return;
    const el = cardRefs.current.get(selectedPath);
    if (el) {
      const container = containerRef.current;
      if (container) container.scrollTo({ top: container.scrollTop + el.getBoundingClientRect().top - container.getBoundingClientRect().top - (container.clientHeight - el.clientHeight) / 2, behavior: "instant" });
    }
  }, [selectedPath]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (isMaximized) {
      if (e.key === "Escape") {
        e.preventDefault();
        onToggleMaximize?.();
        return;
      }
    }

    if (tabs.length === 0) return;
    const currentIndex = tabs.findIndex((t) => t.path === selectedPath);

    if (isLocked) {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        triggerShake();
        onLockedAttempt?.();
        return;
      }
    }

    if (e.key === "ArrowDown" || e.key === "PageDown") {
      e.preventDefault();
      const nextIndex = Math.min(tabs.length - 1, currentIndex + 1);
      onSelectTab(tabs[nextIndex].path);
    } else if (e.key === "ArrowUp" || e.key === "PageUp") {
      e.preventDefault();
      const prevIndex = Math.max(0, currentIndex - 1);
      onSelectTab(tabs[prevIndex].path);
    } else if (e.key === "Home") {
      e.preventDefault();
      onSelectTab(tabs[0].path);
    } else if (e.key === "End") {
      e.preventDefault();
      onSelectTab(tabs[tabs.length - 1].path);
    }
  };

  if (tabs.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-content-muted">
        <TabIcon className="h-5 w-5 opacity-40" />
        <span className="font-utility text-regular font-medium">No tabs in this collection</span>
      </div>
    );
  }

  return (
    // A scrollable composite region needs its own keyboard focus; nested editors keep their keys.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={containerRef}
      role="region"
      aria-label="Workbench card stream"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
      style={{
        scrollSnapType: isLocked || isMaximized ? "none" : "y proximity",
        paddingBlock: isMaximized ? 0 : Math.max(24, deckHeight * 0.08),
      }}
      className={cn(
        "relative flex h-full min-h-0 flex-1 flex-col items-center bg-workspace overscroll-contain outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-content-strong/30",
        isMaximized
          ? "p-0 gap-0 overflow-hidden"
          : "px-3 gap-4",
        isLocked || isMaximized ? "overflow-y-hidden" : "overflow-y-auto",
        className,
      )}
    >
      {tabs.map((tab) => {
        const isSelected = tab.path === selectedPath;
        if (isMaximized && !isSelected) {
          return null;
        }

        const Icon = iconForPath(tab.path, tab.rendererId);
        const ext = extensionOf(tab.path);
        const metric = metrics[tab.path] ?? {
          scale: isSelected ? 1.0 : 0.92,
          opacity: isSelected ? 1.0 : 0.85,
        };

        return (
          <div
            key={tab.path}
            ref={(node) => {
              if (node) cardRefs.current.set(tab.path, node);
              else cardRefs.current.delete(tab.path);
            }}
            style={
              isMaximized
                ? { width: "100%", height: "100%" }
                : {
                    height: deckHeight ? Math.max(256, deckHeight * 0.84) : undefined,
                    scrollSnapAlign: "center",
                    transform: `scale(${isSelected ? 1 : metric.scale})`,
                    opacity: isSelected ? 1 : metric.opacity,
                    willChange: "transform, opacity",
                    transformOrigin: "center center",
                  }
            }
            className={cn(
              "flex flex-shrink-0 flex-col transition-[transform,opacity] duration-200 motion-reduce:transition-none",
              isMaximized ? "h-full w-full" : "w-full max-w-[min(96%,1536px)] min-h-64",
            )}
          >
            <div
              role="tabpanel"
              aria-label={tab.label}
              className={cn(
                "group relative flex flex-col rounded-sm bg-canvas transition-[transform,opacity] duration-200 motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-content-strong/50",
                isMaximized
                  ? "h-full w-full min-h-0 max-h-none rounded-none ring-0 shadow-none"
                  : "h-full min-h-0",
                isSelected && !isMaximized
                  ? "shadow-md elevation-raised"
                  : !isSelected
                    ? "shadow-sm"
                    : "",
                isSelected && isLocked && isShaking && "animate-paper-shake motion-reduce:animate-none",
              )}

            >
              {/* Card Header Bar */}
              <div
                className="flex flex-shrink-0 items-center justify-between border-b border-control/40 px-3 py-2 select-none cursor-default"

              >
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className="h-4 w-4 flex-shrink-0 text-content-primary" aria-hidden="true" />
                  {isSelected ? (
                    <span className="min-w-0 truncate font-utility text-regular font-semibold text-content-strong">{tab.label}</span>
                  ) : (
                    <InactiveCardTitle tab={tab} onSelect={() => { if (!isLocked) onSelectTab(tab.path); }} onAddToContext={onAddToContext} />
                  )}
                  <span className="shrink-0 whitespace-nowrap rounded-sm bg-control/60 px-2 py-1 text-minimal font-utility text-content-muted">
                    {tab.rendererTitle || ext || "tab"}
                  </span>
                  {tab.hasError && <span className="shrink-0 text-compact text-danger-400" role="status">Syntax error</span>}
                  {tab.hasContext && (
                    <AddContextIcon className="h-4 w-4 text-accent-400 flex-shrink-0" aria-label="Added to context" />
                  )}
                  {tab.isDirty && (
                    <PresenceDot
                      contentSize="small"
                      className="bg-warning-400 flex-shrink-0"
                      title="Unsaved changes"
                    />
                  )}
                  {isSelected && isLocked && (
                    <span className="flex items-center gap-1 rounded-sm bg-control/60 px-2 py-1 text-minimal font-utility text-content-muted select-none">
                      <Lock className="h-4 w-4 text-accent-400" />
                      Locked
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1">
                  {Boolean(tab.noteCount && tab.noteCount > 0) && (
                    <span className="rounded-sm bg-control px-2 py-1 text-minimal font-utility text-content-secondary">
                      {tab.noteCount} notes
                    </span>
                  )}
                </div>
              </div>

              {/* Card Body: Interactive content for active card, summary snapshot for inactive */}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {isSelected ? (
                  <div className="h-full min-h-0 flex-1 overflow-hidden">
                    {renderActiveCardContent(tab.path)}
                  </div>
                ) : (
                  <div
                    className="flex h-full min-h-0 flex-1 flex-col p-6 overflow-hidden select-none"

                  >
                    <div className="font-reading text-comfortable text-content-strong line-clamp-3 mb-3 font-semibold">
                      {tab.label}
                    </div>
                    {tab.previewSnippet ? (
                      <p className="font-reading text-regular text-content-secondary line-clamp-12 whitespace-pre-wrap leading-relaxed">
                        {tab.previewSnippet}
                      </p>
                    ) : (
                      <div className="flex flex-1 items-center justify-center text-compact text-content-muted">
                        Select the card title to view and edit
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
