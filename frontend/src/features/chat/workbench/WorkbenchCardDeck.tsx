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
  Paperclip,
  Table,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { TabIcon } from "@/components/ui/editorial-icons";
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

export function WorkbenchCardDeck({
  tabs,
  selectedPath,
  onSelectTab,
  renderActiveCardContent,
  onAddToContext,
  isLocked = false,
  shakeNonce,
  onLockedAttempt,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [metrics, setMetrics] = useState<Record<string, { scale: number; opacity: number }>>({});
  const [isShaking, setIsShaking] = useState(false);
  const shakeTimeoutRef = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);
  const isUserScrollingRef = useRef(false);
  const scrollEndTimeoutRef = useRef<number | null>(null);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;

  const triggerShake = useCallback(() => {
    if (shakeTimeoutRef.current !== null) clearTimeout(shakeTimeoutRef.current);
    setIsShaking(true);
    onLockedAttempt?.();
    shakeTimeoutRef.current = window.setTimeout(() => {
      setIsShaking(false);
      shakeTimeoutRef.current = null;
    }, 380);
  }, [onLockedAttempt]);

  useEffect(() => {
    if (shakeNonce && shakeNonce > 0) {
      triggerShake();
    }
  }, [shakeNonce, triggerShake]);

  // Listen to wheel events on container when locked to trigger shake without scrolling
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isLocked) return;

    const onWheel = (e: globalThis.WheelEvent) => {
      if (Math.abs(e.deltaY) > 2 || Math.abs(e.deltaX) > 2) {
        e.preventDefault();
        e.stopPropagation();
        triggerShake();
      }
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [isLocked, triggerShake]);

  const calculateTransforms = useCallback(() => {
    const container = containerRef.current;
    if (!container || tabs.length === 0) return;

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
      const opacity = 0.55 + factor * 0.45;

      nextMetrics[tab.path] = {
        scale: Number(scale.toFixed(3)),
        opacity: Number(opacity.toFixed(3)),
      };
    }

    setMetrics(nextMetrics);
    return closestPath;
  }, [tabs]);

  const handleScroll = useCallback(() => {
    if (isLocked) return;

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
  }, [calculateTransforms, isLocked, onSelectTab]);

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
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [selectedPath]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return;
    const currentIndex = tabs.findIndex((t) => t.path === selectedPath);

    if (isLocked) {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        triggerShake();
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
    <div
      ref={containerRef}
      role="region"
      aria-label="Workbench card stream"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
      style={{
        scrollSnapType: isLocked ? "none" : "y proximity",
      }}
      className={cn(
        "relative flex h-full min-h-0 flex-1 flex-col items-center gap-8 overscroll-contain px-4 py-16 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-content-strong/30 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        isLocked ? "overflow-y-hidden" : "overflow-y-auto",
        className,
      )}
    >
      {tabs.map((tab) => {
        const isSelected = tab.path === selectedPath;
        const Icon = iconForPath(tab.path, tab.rendererId);
        const ext = extensionOf(tab.path);
        const metric = metrics[tab.path] ?? {
          scale: isSelected ? 1.0 : 0.92,
          opacity: isSelected ? 1.0 : 0.55,
        };

        return (
          <div
            key={tab.path}
            ref={(node) => {
              if (node) cardRefs.current.set(tab.path, node);
              else cardRefs.current.delete(tab.path);
            }}
            style={{
              scrollSnapAlign: "center",
              transform: `scale(${metric.scale})`,
              opacity: metric.opacity,
              willChange: "transform, opacity",
              transformOrigin: "center center",
            }}
            className="flex w-full max-w-4xl flex-shrink-0 flex-col transition-all duration-200"
          >
            <div
              role="tabpanel"
              aria-label={tab.label}
              tabIndex={isSelected ? undefined : 0}
              onKeyDown={(e) => {
                if (!isSelected && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  if (isLocked) {
                    triggerShake();
                    return;
                  }
                  onSelectTab(tab.path);
                }
              }}
              className={cn(
                "group relative flex min-h-[60vh] max-h-[78vh] h-[72vh] flex-col rounded-sm bg-panel ring-1 ring-inset transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-content-strong/50",
                isSelected
                  ? "ring-control/60 shadow-md elevation-raised"
                  : "ring-control/30 shadow-sm opacity-60 hover:opacity-90 hover:ring-control/40 cursor-pointer",
                isSelected && isShaking && "animate-paper-shake",
              )}
              onClick={() => {
                if (isLocked && !isSelected) {
                  triggerShake();
                  return;
                }
                if (!isSelected) onSelectTab(tab.path);
              }}
            >
              {/* Card Header Bar */}
              <div className="flex flex-shrink-0 items-center justify-between border-b border-control/40 px-3 py-2 select-none">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className="h-4 w-4 flex-shrink-0 text-content-primary" aria-hidden="true" />
                  <span className="truncate font-utility text-regular font-semibold text-content-strong">
                    {tab.label}
                  </span>
                  <span className="rounded-sm bg-control/60 px-2 py-1 text-minimal font-utility text-content-muted">
                    {tab.rendererTitle || ext || "tab"}
                  </span>
                  {tab.hasContext && (
                    <Paperclip className="h-3.5 w-3.5 text-accent-400 flex-shrink-0" aria-label="Added to context" />
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
                      <Lock className="h-3.5 w-3.5 text-accent-400" />
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
                    onContextMenu={(e) => {
                      if (onAddToContext) {
                        e.preventDefault();
                        onAddToContext(tab.path);
                      }
                    }}
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
                        Click card to view and edit
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
