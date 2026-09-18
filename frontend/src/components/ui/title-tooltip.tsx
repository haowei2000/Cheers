import { useEffect, useId, useRef, useState } from "react";
import { FloatingLayer } from "./floating-layer";
import { contrastTooltipSurfaceClasses } from "./tooltip-surface";
import {
  clearPointerInteraction,
  isPointerFocus,
  markPointerInteraction,
  onDisarmHover,
  whenPointerRests,
} from "@/lib/hoverIntent";

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
    let cancelRest: (() => void) | null = null;

    const switchTo = (next: HTMLElement | null, immediate: boolean) => {
      if (active?.anchor === next) return;
      cancelRest?.();
      cancelRest = null;
      setVisible(null);
      if (active) restoreTitle(active, tooltipId);
      active = null;
      anchorRef.current = null;

      if (!next) return;
      // The title is taken the moment the pointer arrives, so the native bubble
      // never gets its chance — the decision still pending is only ours.
      const captured = captureTitle(next, tooltipId);
      if (!captured) return;
      active = captured;
      anchorRef.current = next;
      const show = () => {
        if (active?.anchor !== next) return;
        if (!next.isConnected) {
          close();
          return;
        }
        const rect = next.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          close();
          return;
        }
        setVisible({
          text: captured.text,
          align: resolveTitleTooltipAlign(rect.left, rect.right, window.innerWidth),
        });
      };
      // Focus asks outright; a pointer asks by coming to rest on the control.
      if (immediate) show();
      else cancelRest = whenPointerRests(next, show);
    };

    const close = () => {
      hovered = null;
      focused = null;
      switchTo(null, false);
    };

    const onPointerDown = () => {
      markPointerInteraction();
      close();
    };

    const onPointerUp = () => {
      clearPointerInteraction();
    };

    const onClick = () => {
      markPointerInteraction();
      close();
    };

    const onPointerMove = () => {
      // If a tooltip was opened by keyboard focus and the user moves the mouse,
      // dismiss the keyboard tooltip so it doesn't linger or confuse the user.
      if (focused && !hovered) {
        focused = null;
        switchTo(null, false);
      }
    };

    const onPointerOver = (event: PointerEvent) => {
      // Ignore pointerover while dragging or pressing buttons
      if (event.buttons !== 0) return;
      const next = titleAnchor(event.target);
      if (!next) return;
      hovered = next;
      switchTo(hovered, false);
    };

    const onPointerOut = (event: PointerEvent) => {
      if (!hovered || remainsInside(hovered, event.relatedTarget)) return;
      hovered = null;
      // Mouse left the element: always close tooltip, never fall back to focused!
      switchTo(null, false);
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      // Clicks/pointer taps or non-visible focus should never pop up tooltips
      if (isPointerFocus(event)) {
        focused = null;
        return;
      }

      const next = titleAnchor(target);
      if (!next) return;
      focused = next;
      switchTo(focused, true);
    };

    const onFocusOut = (event: FocusEvent) => {
      if (!focused || remainsInside(focused, event.relatedTarget)) return;
      focused = null;
      if (!hovered) {
        switchTo(null, false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    const unsubDisarm = onDisarmHover(close);

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    const onVisibilityChange = () => {
      if (document.hidden) close();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      unsubDisarm();
      cancelRest?.();
      if (active) restoreTitle(active, tooltipId);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
