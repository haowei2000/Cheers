import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { PresenceDot } from "@/components/ui/presence-dot";

export interface TabLocatorItem {
  path: string;
  label: string;
  isDirty?: boolean;
  hasError?: boolean;
  hasContext?: boolean;
}

const GUIDE_COUNT = 4;
const SLOT_HEIGHT = 18;

interface Props {
  tabs: TabLocatorItem[];
  selectedIndex: number;
  onSelectTab: (path: string, index: number) => void;
  isLocked?: boolean;
  shakeNonce?: number;
  onLockedActionAttempt?: () => void;
  className?: string;
}

export function WorkbenchTabLocator({
  tabs,
  selectedIndex,
  onSelectTab,
  isLocked = false,
  shakeNonce,
  onLockedActionAttempt,
  className,
}: Props) {
  const [isShaking, setIsShaking] = useState(false);
  const shakeTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (shakeNonce && shakeNonce > 0) {
      setIsShaking(true);
      if (shakeTimeoutRef.current !== null) {
        clearTimeout(shakeTimeoutRef.current);
      }
      shakeTimeoutRef.current = window.setTimeout(() => {
        setIsShaking(false);
      }, 350);
    }
  }, [shakeNonce]);

  useEffect(() => {
    return () => {
      if (shakeTimeoutRef.current !== null) {
        clearTimeout(shakeTimeoutRef.current);
      }
    };
  }, []);

  if (tabs.length === 0) return null;

  const trackOffset = (GUIDE_COUNT + selectedIndex + 0.5) * SLOT_HEIGHT;

  return (
    <nav
      aria-label="Tab locator"
      className={cn(
        "relative flex w-6 flex-shrink-0 flex-col items-center justify-center overflow-hidden select-none",
        isShaking && "animate-paper-shake",
        className,
      )}
    >
      {/* Dynamic rolling ruler track */}
      <div
        role="tablist"
        aria-orientation="vertical"
        className="absolute left-1 flex flex-col items-start transition-transform duration-250 ease-out will-change-transform"
        style={{
          top: "50%",
          transform: `translateY(-${trackOffset}px)`,
        }}
      >
        {/* Top guide ticks */}
        {/* design-system-exempt: step-indicator — ruler guide marks */}
        {Array.from({ length: GUIDE_COUNT }).map((_, i) => (
          <div
            key={`guide-top-${i}`}
            aria-hidden="true"
            className="flex h-[18px] items-center"
          >
            <div className="h-[1px] w-1 rounded-none bg-content-muted/20" />
          </div>
        ))}

        {/* Tab ruler ticks */}
        {/* design-system-exempt: step-indicator — tab locator ticks */}
        {tabs.map((tab, idx) => {
          const isSelected = idx === selectedIndex;
          const diff = Math.abs(idx - selectedIndex);

          // Scaled widths: active 16px (w-4), diff=1 10px (w-2.5), diff=2 6px (w-1.5), diff>=3 4px (w-1)
          const tickWidth = isSelected
            ? "w-4"
            : diff === 1
              ? "w-2.5"
              : diff === 2
                ? "w-1.5"
                : "w-1";

          const tickHeight = isSelected
            ? "h-[2px]"
            : diff === 1
              ? "h-[1.5px]"
              : "h-[1px]";

          const tickBg = isSelected
            ? "bg-content-strong shadow-xs"
            : diff === 1
              ? "bg-content-muted/80 hover:bg-content-primary"
              : "bg-content-muted/40 hover:bg-content-primary";

          return (
            <div
              key={tab.path}
              role="tab"
              tabIndex={0}
              aria-selected={isSelected}
              aria-label={`${tab.label} (${idx + 1} of ${tabs.length})`}
              title={
                isLocked && !isSelected
                  ? `${tab.label} (locked)`
                  : `${tab.label} (${idx + 1}/${tabs.length})`
              }
              onClick={() => {
                if (isLocked && !isSelected) {
                  onLockedActionAttempt?.();
                  return;
                }
                onSelectTab(tab.path, idx);
              }}
              onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (isLocked && !isSelected) {
                    onLockedActionAttempt?.();
                    return;
                  }
                  onSelectTab(tab.path, idx);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  if (isLocked) {
                    onLockedActionAttempt?.();
                    return;
                  }
                  const next = Math.min(tabs.length - 1, idx + 1);
                  onSelectTab(tabs[next].path, next);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  if (isLocked) {
                    onLockedActionAttempt?.();
                    return;
                  }
                  const prev = Math.max(0, idx - 1);
                  onSelectTab(tabs[prev].path, prev);
                }
              }}
              className="group relative flex h-[18px] items-center cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-content-strong"
            >
              {/* Horizontal tick line */}
              <div
                className={cn(
                  "rounded-none transition-all duration-200",
                  tickWidth,
                  tickHeight,
                  tickBg,
                )}
              />

              {/* Dirty indicator */}
              {tab.isDirty && (
                <PresenceDot
                  contentSize="small"
                  className="ml-1 bg-warning-400"
                  title="Unsaved changes"
                />
              )}
            </div>
          );
        })}

        {/* Bottom guide ticks */}
        {/* design-system-exempt: step-indicator — ruler guide marks */}
        {Array.from({ length: GUIDE_COUNT }).map((_, i) => (
          <div
            key={`guide-bottom-${i}`}
            aria-hidden="true"
            className="flex h-[18px] items-center"
          >
            <div className="h-[1px] w-1 rounded-none bg-content-muted/20" />
          </div>
        ))}
      </div>
    </nav>
  );
}
