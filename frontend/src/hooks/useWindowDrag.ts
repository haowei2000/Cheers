// Drag + resize + stacking for the floating instrument windows (ViewBoard,
// Workbench, Channel files, Remote workspace). Non-modal windows float over the
// chat, so they need (a) a drag handle to get out of each other's way, (b) a
// resize grip, and (c) a small z-order so the clicked window comes to the front.
//
// Geometry (position + size) persists per window (localStorage key) and is
// clamped into the viewport on load and while dragging/resizing, so a stale
// value can never strand a window off-screen. Mobile renders windows as
// full-screen sheets — pass `enabled: false` there and the hook is inert.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { placeNearRect, type AnchorPlacement } from "@/components/ui/floating-layer";
import {
  beginSnap,
  updateSnap,
  endSnap,
  getSnapState,
  suggestSpawn,
  setOccupant,
  getOccupants,
  subscribeOccupants,
  isNearlyFill,
  type SpawnKind,
} from "@/features/chat/workbench/laneSnap";

// ── z-order: bottom→top list of window keys; raise() moves a key to the top ──
// Base 40 keeps every floating window below true modals (Dialog & co. sit at
// z-50): with the 4 windows the max is 43.
const zOrder: string[] = [];
const zListeners = new Set<() => void>();

function raise(key: string) {
  const i = zOrder.indexOf(key);
  if (i === zOrder.length - 1 && i !== -1) return; // already on top
  if (i !== -1) zOrder.splice(i, 1);
  zOrder.push(key);
  zListeners.forEach((l) => l());
}

function subscribeZ(l: () => void) {
  zListeners.add(l);
  return () => {
    zListeners.delete(l);
  };
}

interface Pos {
  x: number;
  y: number;
}

interface Size {
  w: number;
  h: number;
}

/** Persisted geometry: position from dragging, size from resizing (both optional). */
interface Geom extends Partial<Pos>, Partial<Size> {}

// Keep at least a grabbable sliver of the window inside the viewport.
const MIN_VISIBLE_X = 80;
const MIN_TOP = 8;
const MIN_VISIBLE_Y = 48;
// Resize floors — small enough for a compact card, big enough to stay usable.
const MIN_W = 280;
const MIN_H = 160;

// Clamp a top-left position. In BOUNDED mode (`bounds` given, e.g. the work
// lane) coordinates are local to that box and the window is kept fully inside
// it — the lane is a canvas, not the whole screen. Otherwise coordinates are
// viewport-absolute and we only keep a grabbable sliver on-screen.
function clampPos(pos: Pos, width: number, height: number, bounds: DOMRect | null): Pos {
  if (bounds) {
    return {
      x: Math.min(Math.max(pos.x, 0), Math.max(0, bounds.width - width)),
      y: Math.min(Math.max(pos.y, 0), Math.max(0, bounds.height - Math.min(height, bounds.height))),
    };
  }
  return {
    x: Math.min(Math.max(pos.x, MIN_VISIBLE_X - width), window.innerWidth - MIN_VISIBLE_X),
    y: Math.min(Math.max(pos.y, MIN_TOP), window.innerHeight - MIN_VISIBLE_Y),
  };
}

export interface WindowDrag {
  /** Attach to the window's root element (measured on drag/resize start). */
  ref: (el: HTMLElement | null) => void;
  /** Dragged position, or null while the window still sits at its default CSS spot. */
  pos: Pos | null;
  /** Resized size, or null while the window keeps its default CSS size. */
  size: Size | null;
  /** Stacking order (40..40+n) — highest = frontmost. */
  z: number;
  /** Spread onto the drag handle (the window's title bar). */
  handleProps: {
    onPointerDown: (e: ReactPointerEvent) => void;
    style: CSSProperties;
  };
  /** Spread onto a bottom-right resize grip. */
  resizeProps: {
    onPointerDown: (e: ReactPointerEvent) => void;
    style: CSSProperties;
  };
  /** Full style for the window root: position + size overrides + stacking. */
  style: CSSProperties;
  /** Position + stacking only (no size) — for collapsed/minimized rendering. */
  posStyle: CSSProperties;
  /** True while a bounds box is active — the root should use `absolute` (inside
   *  the positioned lane) rather than `fixed` (the viewport). */
  bounded: boolean;
  /** Bring this window to the front (also wired into the handle's pointerdown). */
  toFront: () => void;
  /** Forget the dragged/resized geometry (window snaps back to its defaults). */
  reset: () => void;
}

export interface WindowDragOptions {
  /** Bounded windows only: while dragging, publish the cursor to the lane snap
   *  store (drives the LaneZones overlay) and, on drop, snap position+size to the
   *  resolved zone. No-op when there's no bounds (free viewport float). */
  snap?: boolean;
  /** When set, a first open with no persisted geometry picks a free lane zone
   *  (or fills the lane alone) instead of stacking every panel at top-left. */
  spawnKind?: SpawnKind;
  /** Panel visibility — spawn/occupant tracking only while open. Defaults true. */
  open?: boolean;
  /** Free (viewport) windows: place near this element when opening. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Ignore persisted x/y on each open and re-place near `anchorRef` (keeps w/h). */
  reanchorOnOpen?: boolean;
  /** Preferred side of the anchor for a viewport float. */
  anchorPlacement?: AnchorPlacement;
}

// `getBounds` (optional) turns on BOUNDED mode: the window floats inside that
// box (the work lane) with `absolute` positioning and lane-local coordinates,
// instead of over the whole viewport. It's read live on every drag/resize so a
// resized lane is always respected.
export function useWindowDrag(
  storageKey: string,
  enabled = true,
  getBounds?: () => DOMRect | null,
  // Bounded windows only: while dragging, publish the cursor to the lane snap
  // store (drives the LaneZones overlay) and, on drop, snap position+size to the
  // resolved zone. No-op when there's no bounds (free viewport float).
  // Prefer `options.snap` for new call sites; the boolean form stays for
  // FloatingPanel / existing callers.
  snapOrOptions: boolean | WindowDragOptions = false
): WindowDrag {
  const opts: WindowDragOptions =
    typeof snapOrOptions === "boolean" ? { snap: snapOrOptions } : snapOrOptions;
  const snap = opts.snap ?? false;
  const spawnKind = opts.spawnKind;
  const panelOpen = opts.open ?? true;
  const anchorRef = opts.anchorRef;
  const reanchorOnOpen = opts.reanchorOnOpen ?? false;
  const anchorPlacement = opts.anchorPlacement ?? "down";
  const [geom, setGeom] = useState<Geom>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return {};
      const g = JSON.parse(raw) as Geom;
      if (typeof g !== "object" || g === null) return {};
      // Re-anchored inspectors keep size, not a stale corner from last open.
      if (reanchorOnOpen) {
        const next: Geom = {};
        if (typeof g.w === "number") next.w = g.w;
        if (typeof g.h === "number") next.h = g.h;
        return next;
      }
      return g;
    } catch {
      return {};
    }
  });
  const elRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeRef = useRef<{ w: number; h: number; px: number; py: number } | null>(null);
  // Window-level move/up/cancel teardown — WKWebView often drops element capture
  // once the cursor leaves the title bar, so we drive the gesture from `window`.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const geomRef = useRef(geom);
  geomRef.current = geom;

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      resizeCleanupRef.current?.();
    };
  }, []);

  // Register in the stacking order on mount (new windows open on top).
  useEffect(() => {
    raise(storageKey);
    return () => {
      const i = zOrder.indexOf(storageKey);
      if (i !== -1) {
        zOrder.splice(i, 1);
        zListeners.forEach((l) => l());
      }
    };
  }, [storageKey]);

  // Free viewport floats: pin beside the trigger (with auto-flip) when there is
  // no position yet, or when the caller asks to re-anchor on every open.
  useLayoutEffect(() => {
    if (!enabled || !panelOpen || getBounds) return;
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const g = geomRef.current;
    if (!reanchorOnOpen && g.x != null && g.y != null) return;
    const el = elRef.current;
    const w = g.w ?? el?.offsetWidth ?? 640;
    const h = g.h ?? el?.offsetHeight ?? 480;
    const placed = placeNearRect(anchor.getBoundingClientRect(), w, h, anchorPlacement);
    const next: Geom = { ...g, x: placed.x, y: placed.y };
    setGeom(next);
    // Size may already be persisted; don't write until the user drags/resizes.
  }, [enabled, panelOpen, getBounds, anchorRef, reanchorOnOpen, anchorPlacement]);

  const readZ = useCallback(() => {
    const i = zOrder.indexOf(storageKey);
    return 40 + (i === -1 ? 0 : i);
  }, [storageKey]);
  // The third argument is the server snapshot. Without it any server render of a panel
  // throws rather than degrading, which is why FloatingPanel had no component tests —
  // the repo's component tests are renderToStaticMarkup. Off the client there is no
  // stacking order, so every window reports the base layer.
  const z = useSyncExternalStore(subscribeZ, readZ, () => 40);

  const toFront = useCallback(() => raise(storageKey), [storageKey]);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(geomRef.current));
    } catch {
      /* private mode etc. — geometry just won't persist */
    }
  }, [storageKey]);

  // ── dragging (title bar) ──
  // Pointer capture alone is unreliable in macOS WKWebView (Tauri): once the
  // cursor leaves the thin title bar, move/up often never reach the handle.
  // Mirror SessionsPanel — best-effort capture + window listeners for the gesture.
  const onDragDown = useCallback(
    (e: ReactPointerEvent) => {
      toFront();
      if (!enabled) return;
      // Buttons/inputs in the title bar keep their click; only bare header space drags.
      if ((e.target as HTMLElement).closest("button, select, input, a, textarea")) return;
      const panel = elRef.current;
      if (!panel) return;
      const handle = e.currentTarget as HTMLElement;
      const r = panel.getBoundingClientRect();
      dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — window listeners still cover the drag */
      }
      e.preventDefault(); // no text selection while dragging

      const pointerId = e.pointerId;
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        dragCleanupRef.current = null;
        try {
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      };
      dragCleanupRef.current?.();
      dragCleanupRef.current = cleanup;

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const drag = dragRef.current;
        const el = elRef.current;
        if (!drag || !el) return;
        const b = getBounds ? getBounds() : null;
        // In bounded mode the pointer (viewport coords) maps to lane-local coords.
        const x = ev.clientX - drag.dx - (b ? b.left : 0);
        const y = ev.clientY - drag.dy - (b ? b.top : 0);
        const p = clampPos({ x, y }, el.offsetWidth, el.offsetHeight, b);
        setGeom((g) => ({ ...g, ...p }));
        // Feed the cursor (lane-local) to the snap overlay so it can highlight the
        // zone the window will land in. Start the overlay on the first real move
        // (not on pointerdown) so a bare header click never flashes the grid.
        if (snap && b) {
          if (!getSnapState().active) beginSnap({ width: b.width, height: b.height });
          updateSnap({ x: ev.clientX - b.left, y: ev.clientY - b.top });
        }
      };

      const finish = (commit: boolean) => {
        if (!dragRef.current) {
          cleanup();
          return;
        }
        dragRef.current = null;
        cleanup();
        if (!commit) {
          if (snap) endSnap();
          return;
        }
        // Snap to the zone under the drop point (position AND size), if any. Build
        // the snapped geom explicitly and persist THAT — geomRef won't reflect the
        // queued setGeom until the next render, so persist() alone would save the
        // pre-snap position.
        if (snap) {
          const zone = endSnap();
          if (zone) {
            const snapped: Geom = {
              ...geomRef.current,
              x: Math.round(zone.x),
              y: Math.round(zone.y),
              w: Math.round(zone.w),
              h: Math.round(zone.h),
            };
            setGeom(snapped);
            try {
              localStorage.setItem(storageKey, JSON.stringify(snapped));
            } catch {
              /* private mode etc. — geometry just won't persist */
            }
            return;
          }
        }
        persist();
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(true);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(false);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [enabled, toFront, getBounds, snap, persist, storageKey]
  );

  // ── resizing (bottom-right grip) ──
  const onResizeDown = useCallback(
    (e: ReactPointerEvent) => {
      toFront();
      if (!enabled) return;
      const panel = elRef.current;
      if (!panel) return;
      const grip = e.currentTarget as HTMLElement;
      const r = panel.getBoundingClientRect();
      resizeRef.current = { w: r.width, h: r.height, px: e.clientX, py: e.clientY };
      const b = getBounds ? getBounds() : null;
      // Freeze the current spot: a default position is often right-anchored /
      // translated, and resizing an anchored edge moves the window instead of
      // growing it. Pin left/top first so the grip behaves like an OS window.
      // In bounded mode the pinned spot is lane-local.
      setGeom((g) =>
        g.x == null || g.y == null
          ? {
              ...g,
              ...clampPos(
                { x: r.left - (b ? b.left : 0), y: r.top - (b ? b.top : 0) },
                r.width,
                r.height,
                b
              ),
            }
          : g
      );
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — window listeners still cover the resize */
      }
      e.preventDefault();
      e.stopPropagation();

      const pointerId = e.pointerId;
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        resizeCleanupRef.current = null;
        try {
          if (grip.hasPointerCapture(pointerId)) grip.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      };
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = cleanup;

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const rs = resizeRef.current;
        if (!rs) return;
        const bounds = getBounds ? getBounds() : null;
        const g = geomRef.current;
        // In bounded mode a window can't grow past the lane's right/bottom edge
        // from its current top-left; otherwise it's clamped to the viewport.
        const maxW = bounds ? bounds.width - (g.x ?? 0) : window.innerWidth - 16;
        const maxH = bounds ? bounds.height - (g.y ?? 0) : window.innerHeight - 16;
        const w = Math.min(Math.max(rs.w + (ev.clientX - rs.px), MIN_W), maxW);
        const h = Math.min(Math.max(rs.h + (ev.clientY - rs.py), MIN_H), maxH);
        setGeom((gg) => ({ ...gg, w: Math.round(w), h: Math.round(h) }));
      };

      const finish = (commit: boolean) => {
        if (!resizeRef.current) {
          cleanup();
          return;
        }
        resizeRef.current = null;
        cleanup();
        if (commit) persist();
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(true);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(false);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [enabled, toFront, getBounds, persist]
  );

  // A persisted position can fall off-screen after a layout change — a narrower
  // window, a collapsed sidebar, the work lane opening/resizing. Without this a
  // window would "open" in the DOM but render where nobody can see it (looks
  // like it never opened). On mount and on every resize, if the saved top-left
  // is stranded (past the keep-a-sliver bound) pull it FULLY back into the
  // current box for a clean reveal; leave windows parked within bounds alone.
  // Size is already re-clamped at render via min().
  useEffect(() => {
    if (!enabled) return;
    const reclamp = () => {
      const el = elRef.current;
      if (!el) return;
      const b = getBounds ? getBounds() : null;
      const boxW = b ? b.width : window.innerWidth;
      const boxH = b ? b.height : window.innerHeight;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setGeom((g) => {
        if (g.x == null || g.y == null) return g;
        // Only act when the sliver-clamp would move it (i.e. it's stranded).
        const sliver = clampPos({ x: g.x, y: g.y }, w, h, b);
        if (sliver.x === g.x && sliver.y === g.y) return g;
        return {
          ...g,
          x: Math.min(Math.max(g.x, 0), Math.max(0, boxW - w)),
          y: Math.min(Math.max(g.y, 0), Math.max(0, boxH - h)),
        };
      });
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [enabled, getBounds]);

  // First open with no persisted geometry: place into a free lane zone (or fill
  // the lane when alone) instead of every panel defaulting to the same CSS
  // top-left. Re-runs when the panel re-opens after a reset; skipped once the
  // user has a saved geom.
  useEffect(() => {
    if (!enabled || !panelOpen || !spawnKind || !getBounds) return;
    if (geomRef.current.x != null && geomRef.current.y != null) return;
    const b = getBounds();
    if (!b || b.width <= 0 || b.height <= 0) return;
    const placed = suggestSpawn(spawnKind, b, getOccupants(storageKey));
    const next: Geom = {
      x: Math.round(placed.x),
      y: Math.round(placed.y),
      w: Math.round(placed.w),
      h: Math.round(placed.h),
    };
    setGeom(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* private mode — geometry just won't persist */
    }
  }, [enabled, panelOpen, spawnKind, getBounds, storageKey]);

  // A prior alone-fill spawn must yield when a sibling opens, otherwise the new
  // panel lands under a full-lane window. Shrink to our preferred free zone.
  useEffect(() => {
    if (!enabled || !panelOpen || !spawnKind || !getBounds) return;
    const reflow = () => {
      const others = getOccupants(storageKey);
      if (others.length === 0) return;
      const b = getBounds();
      if (!b || b.width <= 0) return;
      const g = geomRef.current;
      if (g.x == null || g.y == null || g.w == null || g.h == null) return;
      if (!isNearlyFill({ x: g.x, y: g.y, w: g.w, h: g.h }, b)) return;
      const placed = suggestSpawn(spawnKind, b, others);
      const next: Geom = {
        x: Math.round(placed.x),
        y: Math.round(placed.y),
        w: Math.round(placed.w),
        h: Math.round(placed.h),
      };
      setGeom(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    };
    reflow();
    return subscribeOccupants(reflow);
  }, [enabled, panelOpen, spawnKind, getBounds, storageKey]);

  // Publish live rect to the spawn registry so a later sibling avoids overlap.
  useEffect(() => {
    if (!enabled || !panelOpen || !getBounds) {
      setOccupant(storageKey, null);
      return () => setOccupant(storageKey, null);
    }
    const b = getBounds();
    const g = geom;
    if (g.x == null || g.y == null || !b) {
      setOccupant(storageKey, null);
      return () => setOccupant(storageKey, null);
    }
    const w = g.w ?? elRef.current?.offsetWidth ?? 0;
    const h = g.h ?? elRef.current?.offsetHeight ?? 0;
    setOccupant(storageKey, { x: g.x, y: g.y, w, h });
    return () => setOccupant(storageKey, null);
  }, [enabled, panelOpen, getBounds, storageKey, geom]);

  const reset = useCallback(() => {
    setGeom({});
    setOccupant(storageKey, null);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  const ref = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  const pos = enabled && geom.x != null && geom.y != null ? { x: geom.x, y: geom.y } : null;
  const size = enabled && geom.w != null && geom.h != null ? { w: geom.w, h: geom.h } : null;

  const boundsAtRender = enabled && getBounds ? getBounds() : null;
  const bounded = boundsAtRender != null;

  const posStyle: CSSProperties = pos
    ? {
        // Absolute inside the lane, fixed over the viewport — set explicitly so it
        // wins over the root's `fixed`/`absolute` className either way.
        position: bounded ? "absolute" : "fixed",
        left: pos.x,
        top: pos.y,
        right: "auto",
        bottom: "auto",
        zIndex: z,
      }
    : bounded
      ? { position: "absolute", zIndex: z }
      : { zIndex: z };
  // min() re-clamps a persisted size against the CURRENT box so an oversized card
  // never overflows. Bounded windows cap against `100%` — the LIVE lane box (their
  // absolute containing block) — so dragging the lane splitter narrower re-fits
  // them with no re-render; the className's max-w/max-h (calc(100%-2rem)) keeps
  // the 2rem inset. Free (fixed) windows cap against the viewport instead.
  const sizeStyle: CSSProperties = size
    ? bounded
      ? {
          width: `min(${size.w}px, 100%)`,
          height: `min(${size.h}px, 100%)`,
        }
      : {
          width: `min(${size.w}px, 94vw)`,
          height: `min(${size.h}px, calc(100dvh - 24px))`,
          maxWidth: "none",
          maxHeight: "none",
        }
    : {};

  return {
    ref,
    pos,
    size,
    z,
    bounded,
    handleProps: {
      onPointerDown: onDragDown,
      style: enabled
        ? ({
            cursor: dragRef.current ? "grabbing" : "grab",
            touchAction: "none",
            // Stop WKWebView from promoting Lucide SVGs into a native image drag.
            WebkitUserDrag: "none",
            userSelect: "none",
          } as CSSProperties)
        : {},
    },
    resizeProps: {
      onPointerDown: onResizeDown,
      style: { touchAction: "none", WebkitUserDrag: "none" } as CSSProperties,
    },
    style: { ...posStyle, ...sizeStyle },
    posStyle,
    toFront,
    reset,
  };
}
