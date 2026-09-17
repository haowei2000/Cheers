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
// So hover is armed by evidence. Until the pointer reports travelling a real
// distance, nothing is hovered, and every `hover:` / `group-hover:` utility is
// gated on this flag in tailwind.config.ts.
//
// Tooltips ask for more than that. A highlight follows the cursor; a bubble
// answers a question, and the question is only asked by a pointer that arrives
// and then stays (`whenPointerRests`). Travelling across a toolbar on the way
// somewhere else is not asking, and neither is a cursor left sitting where it
// happened to click.

const IDLE_ATTR = "data-pointer-idle";

/** Hand tremor and trackpad drift move the cursor without the user meaning to,
 *  and a single such pixel used to be enough to arm every held-back hover. */
export const MEANT_MOVE_PX = 6;

export type PointerPoint = { x: number; y: number };

/** Whether the pointer went somewhere, as opposed to trembling where it was. */
export function pointerTravelled(from: PointerPoint | null, to: PointerPoint): boolean {
  if (!from) return false;
  return Math.hypot(to.x - from.x, to.y - from.y) >= MEANT_MOVE_PX;
}

/** How long the pointer must rest on a control before it has asked about it.
 *  One number for every bubble in the app: the ⓘ tip, the `title` replacement
 *  and the overflow reveal all answer at the same speed. */
export const TOOLTIP_REST_MS = 500;

/** Where the pointer was when the page last changed under it — the point that
 *  `MEANT_MOVE_PX` is measured from. Null until the pointer reports itself. */
let restingPoint: { x: number; y: number } | null = null;

/** A press since the pointer last travelled. Clicks open dialogs, menus, panels
 *  and pages under a cursor that never moved, so what is under it afterwards is
 *  not what was pointed at — no bubble until the pointer says otherwise. The CSS
 *  guard deliberately does not use this: a press must not drop the hover styling
 *  of the very control being clicked. */
let pressedSinceMove = false;

export const POINTER_FOCUS_SUPPRESS_MS = 600;

let lastPointerTime = 0;
let isPointerInteracting = false;

/**
 * Record that pointer interaction (mouse/touch click or press) just occurred.
 * Call this when a pointerdown or click event happens to suppress accidental tooltips.
 */
export function markPointerInteraction(): void {
  lastPointerTime = Date.now();
  isPointerInteracting = true;
}

/**
 * Clear pointer press state once the pointer is released.
 */
export function clearPointerInteraction(): void {
  isPointerInteracting = false;
}

/**
 * Check whether a focus event originated from pointer interaction (mouse click, tap)
 * rather than intentional keyboard navigation (Tab key).
 *
 * Browsers fire focus events when buttons or focusable elements are clicked with
 * a mouse/pointer. Components should check this before opening tooltips or help bubbles.
 */
export function isPointerFocus(event?: FocusEvent | Event): boolean {
  if (isPointerInteracting) return true;
  if (Date.now() - lastPointerTime < POINTER_FOCUS_SUPPRESS_MS) return true;
  if (
    event &&
    "target" in event &&
    typeof HTMLElement !== "undefined" &&
    event.target instanceof HTMLElement
  ) {
    try {
      if (typeof event.target.matches === "function" && !event.target.matches(":focus-visible")) {
        return true;
      }
    } catch {
      // Ignore selector errors in environments without :focus-visible support
    }
  }
  return false;
}

const disarmListeners = new Set<() => void>();

export function onDisarmHover(listener: () => void): () => void {
  disarmListeners.add(listener);
  return () => disarmListeners.delete(listener);
}

/** The page changed under a pointer that has not reported moving since. */
export function disarmHover(): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute(IDLE_ATTR, "");
  }
  restingPoint = null;
  for (const listener of disarmListeners) {
    listener();
  }
}


/** Whether the pointer has reported moving since the page last changed under it.
 *  JS hover handlers need the same answer the CSS guard encodes: `pointerover`
 *  fires when the element under the cursor changes, and content arriving under a
 *  still cursor changes it just as a movement would. */
export function pointerHasMoved(): boolean {
  return !document.documentElement.hasAttribute(IDLE_ATTR);
}

/** Whether the pointer is in a position it chose: it has travelled since the page
 *  last changed under it, and has not pressed anything since. */
export function pointerIsAsking(): boolean {
  return pointerHasMoved() && !pressedSinceMove;
}

function covers(element: Element, x: number, y: number): boolean {
  const under = document.elementFromPoint(x, y);
  return !!under && element.contains(under);
}

/**
 * Run a hover effect only once the pointer has proved it meant this element.
 *
 * `mouseenter` / `pointerover` fire whenever the element under the cursor changes,
 * and content arriving under a still cursor changes it exactly as an approach does.
 * Dropping such an event outright would cost the effect entirely — the cursor is
 * already inside, so no second enter is coming — so it is held until the pointer
 * travels, then honoured only if the cursor is still over the element it was meant
 * for. A pointer that moved away instead simply never triggers it.
 */
export function whenPointerMeans(element: Element, run: () => void): void {
  if (pointerHasMoved()) {
    run();
    return;
  }
  // On `window`, so the watcher registered at startup has already turned this
  // move into evidence by the time it is read here.
  const honour = (event: PointerEvent) => {
    if (!pointerHasMoved()) return; // still inside the tremor radius
    window.removeEventListener("pointermove", honour);
    if (!element.isConnected) return;
    if (covers(element, event.clientX, event.clientY)) run();
  };
  window.addEventListener("pointermove", honour, { passive: true });
}

/**
 * Open a tooltip once the pointer has *asked about* `element`: it is in a position
 * it chose (travelled since the page last changed, no press since), it is over the
 * element, and it has then held still for `TOOLTIP_REST_MS`.
 *
 * Resting is the whole point. A timer started on `pointerover` fires at whatever
 * the pointer happens to be doing when it expires, so crossing a row of icons on
 * the way to the composer pops a bubble out of a control the user was only passing.
 * Movement restarts the wait; a press abandons it.
 *
 * Returns a cancel for the caller's `mouseleave` / unmount.
 */
export function whenPointerRests(
  element: Element,
  run: () => void,
  restMs: number = TOOLTIP_REST_MS,
): () => void {
  let timer: number | undefined;
  let waypoint: { x: number; y: number } | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerdown", stop);
  };

  const countdown = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      stop();
      if (element.isConnected) run();
    }, restMs);
  };

  function onMove(event: PointerEvent) {
    if (!element.isConnected) {
      stop();
      return;
    }
    const from = waypoint;
    const to = { x: event.clientX, y: event.clientY };
    // Drift under the tremor radius is not the pointer travelling on, so it must
    // not keep pushing the answer away forever.
    if (from && !pointerTravelled(from, to)) return;
    waypoint = to;
    if (!pointerIsAsking()) return;
    if (!covers(element, waypoint.x, waypoint.y)) {
      stop();
      return;
    }
    countdown();
  }

  // `window`, after the watcher: these read the evidence it just recorded.
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerdown", stop);
  // Already asking: the enter that brought us here *was* the travel, so the wait
  // starts now. Otherwise the first real movement over the element starts it.
  if (pointerIsAsking()) countdown();
  return stop;
}

let watching = false;

/** Call once, before the first paint, so the opening frame is never pre-hovered. */
export function watchPointerIntent(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  disarmHover();
  // Travel is the only evidence that the pointer is where the user put it. A press
  // is not: clicking without moving says nothing new about where the cursor is, and
  // on touch it is exactly what leaves a tapped row wearing a hover it never earned.
  // A press does however change the page under the cursor, which is why it disarms
  // tooltips (pointerIsAsking) without disarming hover styling.
  window.addEventListener(
    "pointermove",
    (event: PointerEvent) => {
      const point = { x: event.clientX, y: event.clientY };
      if (!restingPoint) {
        // First report since the page changed: it says where the pointer is, not
        // that the user moved it there.
        restingPoint = point;
        return;
      }
      if (!pointerTravelled(restingPoint, point)) return;
      restingPoint = point;
      pressedSinceMove = false;
      document.documentElement.removeAttribute(IDLE_ATTR);
    },
    { passive: true },
  );
  window.addEventListener(
    "pointerdown",
    (event: PointerEvent) => {
      markPointerInteraction();
      pressedSinceMove = true;
      restingPoint = { x: event.clientX, y: event.clientY };
    },
    { passive: true, capture: true },
  );
  window.addEventListener(
    "pointerup",
    () => {
      clearPointerInteraction();
    },
    { passive: true, capture: true },
  );
  window.addEventListener(
    "pointercancel",
    () => {
      clearPointerInteraction();
    },
    { passive: true, capture: true },
  );
  window.addEventListener(
    "click",
    () => {
      markPointerInteraction();
    },
    { passive: true, capture: true },
  );
}
