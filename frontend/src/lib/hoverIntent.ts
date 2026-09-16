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

/** Whether the pointer has reported moving since the page last changed under it.
 *  JS hover handlers need the same answer the CSS guard encodes: `pointerover`
 *  fires when the element under the cursor changes, and content arriving under a
 *  still cursor changes it just as a movement would. */
export function pointerHasMoved(): boolean {
  return !document.documentElement.hasAttribute(IDLE_ATTR);
}

/**
 * Run a hover effect only once the pointer has proved it meant this element.
 *
 * `mouseenter` / `pointerover` fire whenever the element under the cursor changes,
 * and content arriving under a still cursor changes it exactly as an approach does.
 * Dropping such an event outright would cost the effect entirely — the cursor is
 * already inside, so no second enter is coming — so it is held until the pointer
 * moves, then honoured only if the cursor is still over the element it was meant
 * for. A pointer that moved away instead simply never triggers it.
 */
export function whenPointerMeans(element: Element, run: () => void): void {
  if (pointerHasMoved()) {
    run();
    return;
  }
  const honour = (event: PointerEvent) => {
    document.removeEventListener("pointermove", honour);
    if (!element.isConnected) return;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    if (under && element.contains(under)) run();
  };
  document.addEventListener("pointermove", honour, { passive: true });
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
