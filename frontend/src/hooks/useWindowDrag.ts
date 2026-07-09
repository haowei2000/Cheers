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

function clampPos(pos: Pos, width: number): Pos {
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
  /** Bring this window to the front (also wired into the handle's pointerdown). */
  toFront: () => void;
  /** Forget the dragged/resized geometry (window snaps back to its defaults). */
  reset: () => void;
}

export function useWindowDrag(storageKey: string, enabled = true): WindowDrag {
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

  const onDragMove = useCallback((e: ReactPointerEvent) => {
    const drag = dragRef.current;
    const el = elRef.current;
    if (!drag || !el) return;
    const p = clampPos({ x: e.clientX - drag.dx, y: e.clientY - drag.dy }, el.offsetWidth);
    setGeom((g) => ({ ...g, ...p }));
  }, []);

  const onDragUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      persist();
    },
    [persist]
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
      // Freeze the current spot: a default position is often right-anchored /
      // translated, and resizing an anchored edge moves the window instead of
      // growing it. Pin left/top first so the grip behaves like an OS window.
      setGeom((g) =>
        g.x == null || g.y == null ? { ...g, ...clampPos({ x: r.left, y: r.top }, r.width) } : g
      );
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    },
    [enabled, toFront]
  );

  const onResizeMove = useCallback((e: ReactPointerEvent) => {
    const rs = resizeRef.current;
    if (!rs) return;
    const w = Math.min(Math.max(rs.w + (e.clientX - rs.px), MIN_W), window.innerWidth - 16);
    const h = Math.min(Math.max(rs.h + (e.clientY - rs.py), MIN_H), window.innerHeight - 16);
    setGeom((g) => ({ ...g, w: Math.round(w), h: Math.round(h) }));
  }, []);

  const onResizeUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      persist();
    },
    [persist]
  );

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

  const posStyle: CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto", zIndex: z }
    : { zIndex: z };
  // min() re-clamps a persisted size against the CURRENT viewport at render time.
  const sizeStyle: CSSProperties = size
    ? {
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
