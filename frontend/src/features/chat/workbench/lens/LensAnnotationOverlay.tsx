import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import { IconButton } from "@/components/ui/icon-button";
import type { Annotation } from "../annotations";
import { sourcePathKey } from "../annotations";

export interface LensAnnotationOverlayProps {
  containerRef: RefObject<HTMLElement | null>;
  notes: readonly Annotation[];
  activeAnnotationId?: string | null;
  onSelectAnnotation?: (id: string) => void;
}

interface PositionedMarker {
  note: Annotation;
  top: number;
  left: number;
  isActive: boolean;
}

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface MarkerPosition {
  top: number;
  left: number;
}

export function computeMarkerPosition(
  elRect: { top: number; left: number; right: number; bottom: number; width: number; height: number },
  containerRect: { top: number; left: number; right: number; bottom: number; width: number; height: number },
  options?: {
    isTableRow?: boolean;
    lastCellRect?: { left: number; right: number } | null;
    noteIndexOnTarget?: number;
  }
): MarkerPosition | null {
  // Visible in container viewport both vertically and horizontally
  const isVerticallyVisible =
    elRect.bottom >= containerRect.top && elRect.top <= containerRect.bottom;
  const isHorizontallyVisible =
    elRect.right >= containerRect.left && elRect.left <= containerRect.right;
  if (!isVerticallyVisible || !isHorizontallyVisible) return null;

  const relTop = elRect.top - containerRect.top;
  const relLeft = elRect.left - containerRect.left;
  const relRight = elRect.right - containerRect.left;

  // Vertical position: center on compact elements (e.g. table rows or single-line cards),
  // or anchor near top of taller multi-line cards or blocks.
  const verticalOffset = elRect.height <= 44 ? (elRect.height - 24) / 2 : 6;
  const top = Math.max(
    4,
    Math.min(containerRect.height - 28, relTop + verticalOffset)
  );

  // Horizontal position:
  // For table rows, place immediately before the last cell (typically the Delete action column).
  // For cards or other items, place at the right edge of the item.
  let baseLeft: number;
  if (options?.isTableRow && options.lastCellRect) {
    baseLeft = options.lastCellRect.left - containerRect.left - 28;
  } else {
    baseLeft = relRight - 28;
  }

  const noteIndexOnTarget = options?.noteIndexOnTarget ?? 0;
  let left = baseLeft - noteIndexOnTarget * 26;

  // Clamp within container horizontal boundaries and ensure it doesn't spill past element start
  left = Math.max(
    Math.min(relLeft + 4, containerRect.width - 28),
    Math.min(containerRect.width - 28, left)
  );

  return { top, left };
}

export function LensAnnotationOverlay({
  containerRef,
  notes,
  activeAnnotationId,
  onSelectAnnotation,
}: LensAnnotationOverlayProps) {
  const [markers, setMarkers] = useState<PositionedMarker[]>([]);

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      const containerRect = container.getBoundingClientRect();
      const allAnchors = container.querySelectorAll<HTMLElement>("[data-workbench-anchor]");
      const anchorMap = new Map<string, HTMLElement>();
      allAnchors.forEach((el) => {
        const key = el.getAttribute("data-workbench-anchor");
        if (key) anchorMap.set(key, el);
      });

      // Clear previous annotation attributes
      allAnchors.forEach((el) => {
        el.removeAttribute("data-has-annotation");
        el.removeAttribute("data-annotation-active");
      });

      const nextMarkers: PositionedMarker[] = [];
      const seenAnchorCounts = new Map<string, number>();

      notes.forEach((note) => {
        if (note.anchor.kind !== "path") return;
        const key = sourcePathKey(note.anchor.sourcePath);
        const targetEl = anchorMap.get(key);
        if (!targetEl) return;

        const isActive = note.id === activeAnnotationId;
        targetEl.setAttribute("data-has-annotation", "true");
        if (isActive) {
          targetEl.setAttribute("data-annotation-active", "true");
        }

        const elRect = targetEl.getBoundingClientRect();
        const isTableRow =
          targetEl.tagName === "TR" ||
          targetEl.getAttribute("data-workbench-context-target") === "row";
        const lastCell = isTableRow ? targetEl.querySelector("td:last-child") : null;
        const lastCellRect =
          lastCell && targetEl.children.length > 1
            ? lastCell.getBoundingClientRect()
            : null;

        const noteIndexOnTarget = seenAnchorCounts.get(key) ?? 0;
        seenAnchorCounts.set(key, noteIndexOnTarget + 1);

        const pos = computeMarkerPosition(elRect, containerRect, {
          isTableRow,
          lastCellRect,
          noteIndexOnTarget,
        });
        if (!pos) return;

        nextMarkers.push({ note, top: pos.top, left: pos.left, isActive });
      });

      setMarkers(nextMarkers);
    };

    update();

    // Re-sync on scroll (capture to catch nested scrollable containers like tables),
    // resize, or DOM mutations.
    container.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update, { passive: true });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(update);
      ro.observe(container);
    }

    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      mo = new MutationObserver(update);
      mo.observe(container, { childList: true, subtree: true });
    }

    return () => {
      container.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
      ro?.disconnect();
      mo?.disconnect();
      // Clean up attributes on unmount
      allAnchorsCleanup(container);
    };
  }, [containerRef, notes, activeAnnotationId]);

  // Smoothly scroll active annotation into view
  useEffect(() => {
    if (!activeAnnotationId || !containerRef.current) return;
    const activeNote = notes.find((n) => n.id === activeAnnotationId);
    if (!activeNote || activeNote.anchor.kind !== "path") return;
    const key = sourcePathKey(activeNote.anchor.sourcePath);
    const targetEl = containerRef.current.querySelector<HTMLElement>(
      `[data-workbench-anchor='${escapeCssString(key)}']`
    );
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeAnnotationId, notes, containerRef]);

  if (markers.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="false"
      data-testid="lens-annotation-overlay"
    >
      {/* design-system-exempt: menu-option - floating annotation markers */}
      {markers.map(({ note, top, left, isActive }) => (
        <div
          key={note.id}
          style={{
            position: "absolute",
            top: Math.round(top),
            left: Math.round(left),
          }}
          className="pointer-events-auto z-20 inline-flex items-center"
        >
          <IconButton
            label={`Annotation on ${note.label}: ${note.note}`}
            controlSize="compact"
            onClick={(e) => {
              e.stopPropagation();
              onSelectAnnotation?.(note.id);
            }}
            className={
              isActive
                ? "bg-accent-600 text-content-strong ring-1 ring-accent-400 shadow-sm"
                : "bg-panel text-content-primary hover:bg-control/20 hover:text-content-strong shadow-sm"
            }
          >
            <EditorialIcon name="annotation" contentSize="small" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

function allAnchorsCleanup(container: HTMLElement) {
  const allAnchors = container.querySelectorAll<HTMLElement>("[data-workbench-anchor]");
  allAnchors.forEach((el) => {
    el.removeAttribute("data-has-annotation");
    el.removeAttribute("data-annotation-active");
  });
}

function escapeCssString(str: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(str);
  }
  return str.replace(/(["'\\])/g, "\\$1");
}
