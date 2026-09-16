// Hover follows the pointer, not the page.
//
// `:hover` is positional, not event-driven: after a layout change the browser
// recomputes what sits under the cursor and styles it, with no mouse movement
// involved. Nothing clears it either, because clearing also takes a pointer event.
// So a view that mounts under a stationary cursor lights up whatever landed
// beneath it — a row highlighted, or a hover-revealed control simply appearing.
//
// This app makes that likely rather than rare. The chat route carries no `key`,
// so navigating reconciles the existing tree instead of remounting it: the hovered
// DOM node is reused, and the hover it is still carrying lands on whichever row
// now occupies that node. The user's cursor really is over that node — it just
// stopped being the thing they pointed at.
//
// So hover is armed by evidence. Until the pointer reports moving, nothing is
// hovered, and every `hover:` / `group-hover:` utility is gated on this flag in
// tailwind.config.ts.

const IDLE_ATTR = "data-pointer-idle";

/** The page changed under a pointer that has not reported moving since. */
export function disarmHover(): void {
  document.documentElement.setAttribute(IDLE_ATTR, "");
}

let watching = false;

/** Call once, before the first paint, so the opening frame is never pre-hovered. */
export function watchPointerIntent(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  disarmHover();
  // Movement is the only evidence that the pointer is where the user put it. A
  // press is not: clicking without moving says nothing new about where the cursor
  // is, and on touch it is exactly what leaves a tapped row wearing a hover it
  // never earned.
  window.addEventListener(
    "pointermove",
    () => document.documentElement.removeAttribute(IDLE_ATTR),
    { passive: true },
  );
}
