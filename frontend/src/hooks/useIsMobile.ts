import { useSyncExternalStore } from "react";

/**
 * Single source of truth for the app's mobile breakpoint. Kept in lockstep with
 * Tailwind's `md` screen (768px) by subscribing to the *same* `(min-width: 768px)`
 * query Tailwind's `md:`/`max-md:` utilities compile to and negating it — a
 * `(max-width: 767px)` mirror would disagree at fractional viewport widths in
 * (767px, 768px) (reachable via browser zoom or non-integer DPR), where neither
 * query matches. This way layout structure (JSX branches) and styling (classes)
 * flip at exactly the same width. Desktop (>= 768px, and in particular >= 1024px)
 * renders exactly as before — all mobile behavior is additive below this breakpoint.
 */
export const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_MEDIA_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return !window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}

// SSR/snapshot fallback: this app is a pure SPA, but keep the server snapshot
// deterministic (desktop) for tooling that renders without a window.
function getServerSnapshot(): boolean {
  return false;
}

/** True below Tailwind's `md` breakpoint (i.e. on phones). Live-updates on resize/rotate. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
