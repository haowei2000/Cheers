// Drag + resize + stacking for the floating instrument windows (ViewBoard,
// Workbench, Channel files, Remote workspace). Non-modal windows float over the
// chat, so they need (a) a drag handle to get out of each other's way, (b) a
// resize grip, and (c) a small z-order so the clicked window comes to the front.
//
// Geometry (position + size) persists per window (localStorage key) and is
// clamped into the viewport on load and while dragging/resizing, so a stale
// value can never strand a window off-screen. Mobile renders windows as
// full-screen sheets — pass `enabled: false` there and the hook is inert.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  beginSnap,
  updateSnap,
  endSnap,
  getSnapState,
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
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    style: CSSProperties;
  };
  /** Spread onto a bottom-right resize grip. */
  resizeProps: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
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
  snap = false
): WindowDrag {
  const [geom, setGeom] = useState<Geom>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return {};
      const g = JSON.parse(raw) as Geom;
      return typeof g === "object" && g !== null ? g : {};
    } catch {
      return {};
    }
  });
  const elRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeRef = useRef<{ w: number; h: number; px: number; py: number } | null>(null);
  const geomRef = useRef(geom);
  geomRef.current = geom;

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

  const z = useSyncExternalStore(subscribeZ, () => {
    const i = zOrder.indexOf(storageKey);
    return 40 + (i === -1 ? 0 : i);
  });

  const toFront = useCallback(() => raise(storageKey), [storageKey]);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(geomRef.current));
    } catch {
      /* private mode etc. — geometry just won't persist */
    }
  }, [storageKey]);

  // ── dragging (title bar) ──
  const onDragDown = useCallback(
    (e: ReactPointerEvent) => {
      toFront();
      if (!enabled) return;
      // Buttons/inputs in the title bar keep their click; only bare header space drags.
      if ((e.target as HTMLElement).closest("button, select, input, a, textarea")) return;
      const el = elRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault(); // no text selection while dragging
    },
    [enabled, toFront]
  );

  const onDragMove = useCallback(
    (e: ReactPointerEvent) => {
      const drag = dragRef.current;
      const el = elRef.current;
      if (!drag || !el) return;
      const b = getBounds ? getBounds() : null;
      // In bounded mode the pointer (viewport coords) maps to lane-local coords.
      const x = e.clientX - drag.dx - (b ? b.left : 0);
      const y = e.clientY - drag.dy - (b ? b.top : 0);
      const p = clampPos({ x, y }, el.offsetWidth, el.offsetHeight, b);
      setGeom((g) => ({ ...g, ...p }));
      // Feed the cursor (lane-local) to the snap overlay so it can highlight the
      // zone the window will land in. Start the overlay on the first real move
      // (not on pointerdown) so a bare header click never flashes the grid.
      if (snap && b) {
        if (!getSnapState().active) beginSnap({ width: b.width, height: b.height });
        updateSnap({ x: e.clientX - b.left, y: e.clientY - b.top });
      }
    },
    [getBounds, snap]
  );

  const onDragUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
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
    },
    [persist, snap, storageKey]
  );

  // ── resizing (bottom-right grip) ──
  const onResizeDown = useCallback(
    (e: ReactPointerEvent) => {
      toFront();
      if (!enabled) return;
      const el = elRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
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
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    },
    [enabled, toFront, getBounds]
  );

  const onResizeMove = useCallback(
    (e: ReactPointerEvent) => {
      const rs = resizeRef.current;
      if (!rs) return;
      const b = getBounds ? getBounds() : null;
      const g = geomRef.current;
      // In bounded mode a window can't grow past the lane's right/bottom edge
      // from its current top-left; otherwise it's clamped to the viewport.
      const maxW = b ? b.width - (g.x ?? 0) : window.innerWidth - 16;
      const maxH = b ? b.height - (g.y ?? 0) : window.innerHeight - 16;
      const w = Math.min(Math.max(rs.w + (e.clientX - rs.px), MIN_W), maxW);
      const h = Math.min(Math.max(rs.h + (e.clientY - rs.py), MIN_H), maxH);
      setGeom((gg) => ({ ...gg, w: Math.round(w), h: Math.round(h) }));
    },
    [getBounds]
  );

  const onResizeUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      persist();
    },
    [persist]
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

  const reset = useCallback(() => {
    setGeom({});
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
      onPointerMove: onDragMove,
      onPointerUp: onDragUp,
      style: enabled ? { cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none" } : {},
    },
    resizeProps: {
      onPointerDown: onResizeDown,
      onPointerMove: onResizeMove,
      onPointerUp: onResizeUp,
      style: { touchAction: "none" },
    },
    style: { ...posStyle, ...sizeStyle },
    posStyle,
    toFront,
    reset,
  };
}
