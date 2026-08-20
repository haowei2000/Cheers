import { useEffect, useId, useRef, useState } from "react";
import { FloatingLayer } from "./floating-layer";
import { contrastTooltipSurfaceClasses } from "./tooltip-surface";

const SHOW_DELAY_MS = 350;
const EDGE_ZONE_PX = 180;

type TooltipAlign = "start" | "center" | "end";

type CapturedTitle = {
  anchor: HTMLElement;
  text: string;
  previousDescribedBy: string | null;
};

type VisibleTooltip = {
  text: string;
  align: TooltipAlign;
};

export function resolveTitleTooltipAlign(
  left: number,
  right: number,
  viewportWidth: number,
): TooltipAlign {
  if (left < EDGE_ZONE_PX) return "start";
  if (viewportWidth - right < EDGE_ZONE_PX) return "end";
  return "center";
}

export function captureTitle(anchor: HTMLElement, tooltipId: string): CapturedTitle | null {
  const rawTitle = anchor.getAttribute("title");
  const text = rawTitle?.trim();
  if (!text) return null;

  const captured = {
    anchor,
    text,
    previousDescribedBy: anchor.getAttribute("aria-describedby"),
  };
  anchor.removeAttribute("title");
  anchor.setAttribute("aria-describedby", tooltipId);
  return captured;
}

export function restoreTitle(captured: CapturedTitle, tooltipId: string) {
  const { anchor, text, previousDescribedBy } = captured;
  if (!anchor.hasAttribute("title")) anchor.setAttribute("title", text);
  if (anchor.getAttribute("aria-describedby") !== tooltipId) return;
  if (previousDescribedBy) anchor.setAttribute("aria-describedby", previousDescribedBy);
  else anchor.removeAttribute("aria-describedby");
}

function titleAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLElement>("[title]");
  if (!anchor || anchor.closest("[data-managed-tooltip='true']")) return null;
  return anchor;
}

function remainsInside(anchor: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Node && anchor.contains(target);
}

/**
 * Replaces native `title` bubbles with one consistent, accessible tooltip.
 * Event delegation keeps dynamically rendered controls covered without adding
 * wrappers that could change their layout or hover behavior.
 */
export function TitleTooltip() {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState<VisibleTooltip | null>(null);

  useEffect(() => {
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let active: CapturedTitle | null = null;
    let showTimer: number | undefined;

    const switchTo = (next: HTMLElement | null) => {
      if (active?.anchor === next) return;
      window.clearTimeout(showTimer);
      showTimer = undefined;
      setVisible(null);
      if (active) restoreTitle(active, tooltipId);
      active = null;
      anchorRef.current = null;

      if (!next) return;
      const captured = captureTitle(next, tooltipId);
      if (!captured) return;
      active = captured;
      anchorRef.current = next;
      const rect = next.getBoundingClientRect();
      const align = resolveTitleTooltipAlign(rect.left, rect.right, window.innerWidth);
      showTimer = window.setTimeout(() => {
        if (active?.anchor === next) setVisible({ text: captured.text, align });
      }, SHOW_DELAY_MS);
    };

    const sync = () => switchTo(hovered ?? focused);
    const close = () => {
      hovered = null;
      focused = null;
      switchTo(null);
    };

    const onPointerOver = (event: PointerEvent) => {
      const next = titleAnchor(event.target);
      if (!next) return;
      hovered = next;
      sync();
    };
    const onPointerOut = (event: PointerEvent) => {
      if (!hovered || remainsInside(hovered, event.relatedTarget)) return;
      hovered = null;
      sync();
    };
    const onFocusIn = (event: FocusEvent) => {
      const next = titleAnchor(event.target);
      if (!next) return;
      focused = next;
      sync();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!focused || remainsInside(focused, event.relatedTarget)) return;
      focused = null;
      sync();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.clearTimeout(showTimer);
      if (active) restoreTitle(active, tooltipId);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [tooltipId]);

  if (!visible) return null;
  return (
    <FloatingLayer
      anchorRef={anchorRef}
      placement="up"
      align={visible.align}
      id={tooltipId}
      role="tooltip"
      className={contrastTooltipSurfaceClasses}
    >
      {visible.text}
    </FloatingLayer>
  );
}
