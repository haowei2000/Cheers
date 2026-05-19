import { useEffect } from "react";

const VIEWPORT_HEIGHT_VAR = "--an-viewport-height";
const VIEWPORT_OFFSET_TOP_VAR = "--an-viewport-offset-top";
const KEYBOARD_INSET_VAR = "--an-keyboard-inset";

function px(value: number): string {
  return `${Math.max(0, Math.round(value))}px`;
}

export function useMobileViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = 0;

    const apply = () => {
      frame = 0;
      const visualHeight = viewport?.height ?? window.innerHeight;
      const visualOffsetTop = viewport?.offsetTop ?? 0;
      const keyboardInset = viewport
        ? window.innerHeight - visualHeight - visualOffsetTop
        : 0;

      root.style.setProperty(VIEWPORT_HEIGHT_VAR, px(visualHeight));
      root.style.setProperty(VIEWPORT_OFFSET_TOP_VAR, px(visualOffsetTop));
      root.style.setProperty(KEYBOARD_INSET_VAR, px(keyboardInset));
    };

    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };

    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      root.style.removeProperty(VIEWPORT_HEIGHT_VAR);
      root.style.removeProperty(VIEWPORT_OFFSET_TOP_VAR);
      root.style.removeProperty(KEYBOARD_INSET_VAR);
    };
  }, []);
}
