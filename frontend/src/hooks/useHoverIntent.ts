import { useEffect, useRef, useState } from "react";

type HoverIntentOptions = {
  /** Require a deliberate pointer dwell before revealing transient controls. */
  showDelayMs?: number;
  /** Keep the surface alive briefly while the pointer crosses a portal gap. */
  hideDelayMs?: number;
  /** Only one controller in an exclusive group may remain visible. */
  exclusiveGroup?: string;
};

type HoverIntentController = {
  show: () => void;
  showNow: () => void;
  hide: () => void;
  dispose: () => void;
};

const activeExclusiveIntent = new Map<string, () => void>();

/**
 * Timer and exclusivity engine kept separate from React so interaction timing
 * can be tested without a DOM. The hook below only owns rendered visibility.
 */
export function createHoverIntentController(
  setVisible: (visible: boolean) => void,
  {
    showDelayMs = 350,
    hideDelayMs = 140,
    exclusiveGroup,
  }: HoverIntentOptions = {},
): HoverIntentController {
  let disposed = false;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const clearShow = () => {
    if (showTimer === null) return;
    clearTimeout(showTimer);
    showTimer = null;
  };
  const clearHide = () => {
    if (hideTimer === null) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  };

  const hideNow = () => {
    clearShow();
    clearHide();
    if (exclusiveGroup && activeExclusiveIntent.get(exclusiveGroup) === hideNow) {
      activeExclusiveIntent.delete(exclusiveGroup);
    }
    if (!disposed) setVisible(false);
  };

  const reveal = () => {
    clearShow();
    clearHide();
    if (disposed) return;
    if (exclusiveGroup) {
      const previous = activeExclusiveIntent.get(exclusiveGroup);
      if (previous && previous !== hideNow) previous();
      activeExclusiveIntent.set(exclusiveGroup, hideNow);
    }
    setVisible(true);
  };

  const show = () => {
    clearHide();
    if (disposed || showTimer !== null) return;
    if (showDelayMs <= 0) reveal();
    else showTimer = setTimeout(reveal, showDelayMs);
  };

  const hide = () => {
    clearShow();
    clearHide();
    if (disposed) return;
    if (hideDelayMs <= 0) hideNow();
    else hideTimer = setTimeout(hideNow, hideDelayMs);
  };

  const dispose = () => {
    clearShow();
    clearHide();
    if (exclusiveGroup && activeExclusiveIntent.get(exclusiveGroup) === hideNow) {
      activeExclusiveIntent.delete(exclusiveGroup);
    }
    disposed = true;
  };

  return { show, showNow: reveal, hide, dispose };
}

/**
 * Hover-visible state that survives the gap between a trigger and a floating
 * panel anchored a few pixels away from it. Pointer entry uses a deliberate
 * dwell; keyboard focus can call `showNow`. A short delayed hide preserves the
 * path across a portal gap without leaving stale surfaces behind.
 */
export function useHoverIntent(options: HoverIntentOptions = {}): {
  visible: boolean;
  show: () => void;
  showNow: () => void;
  hide: () => void;
} {
  const [visible, setVisible] = useState(false);
  const controllerRef = useRef<HoverIntentController>();
  if (!controllerRef.current) {
    controllerRef.current = createHoverIntentController(setVisible, options);
  }

  useEffect(() => () => controllerRef.current?.dispose(), []);

  return {
    visible,
    show: controllerRef.current.show,
    showNow: controllerRef.current.showNow,
    hide: controllerRef.current.hide,
  };
}
