// FancyZones-style snap targets for the lane's floating instrument windows.
//
// While a window is dragged inside the work lane, a partition grid of "zones" is
// overlaid on the lane; the zone under the cursor highlights, and on drop the
// window snaps (position AND size) to that zone's rect. This module is the tiny
// shared store that couples the drag hook (publishes the live cursor) with the
// LaneZones overlay (renders the grid + highlight) — neither imports the other.
//
// Coordinates are LANE-LOCAL (relative to the lane box's top-left), matching the
// `absolute` positioning useWindowDrag uses in bounded mode.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Zone extends Rect {
  id: string;
}

// Breathing room between snapped windows and the lane edges.
export const SNAP_GAP = 8;

// Partition the lane into a clean cols×rows grid (no overlap → every drop
// resolves to exactly one cell). Column/row counts adapt to the lane size so a
// narrow lane stacks vertically and a wide one offers side-by-side thirds.
export function zonesFor(bounds: { width: number; height: number }): Zone[] {
  const { width: w, height: h } = bounds;
  if (w <= 0 || h <= 0) return [];
  const cols = w >= 1000 ? 3 : w >= 620 ? 2 : 1;
  const rows = h >= 480 ? 2 : 1;
  const cw = (w - SNAP_GAP * (cols + 1)) / cols;
  const ch = (h - SNAP_GAP * (rows + 1)) / rows;
  const zones: Zone[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      zones.push({
        id: `z${r}-${c}`,
        x: SNAP_GAP + c * (cw + SNAP_GAP),
        y: SNAP_GAP + r * (ch + SNAP_GAP),
        w: cw,
        h: ch,
      });
    }
  }
  return zones;
}

// The zone a lane-local pointer resolves to: the cell it sits inside, or (when it
// lands in a gap) the cell with the nearest center. Returns null only for a
// degenerate (empty) lane.
export function resolveZone(
  pointer: { x: number; y: number },
  bounds: { width: number; height: number }
): Zone | null {
  const zones = zonesFor(bounds);
  if (!zones.length) return null;
  const inside = zones.find(
    (z) =>
      pointer.x >= z.x &&
      pointer.x <= z.x + z.w &&
      pointer.y >= z.y &&
      pointer.y <= z.y + z.h
  );
  if (inside) return inside;
  let best = zones[0];
  let bestD = Infinity;
  for (const z of zones) {
    const dx = z.x + z.w / 2 - pointer.x;
    const dy = z.y + z.h / 2 - pointer.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = z;
    }
  }
  return best;
}

// ── shared drag state (external store) ─────────────────────────────────────
// Replaced (never mutated in place) on every change so useSyncExternalStore's
// getSnapshot returns a stable-until-changed reference.
export interface SnapState {
  /** Live drag in progress inside a lane. */
  active: boolean;
  /** Lane box size (lane-local origin is 0,0). */
  bounds: { width: number; height: number } | null;
  /** Cursor in lane-local coords, or null before the first move. */
  pointer: { x: number; y: number } | null;
}

let state: SnapState = { active: false, bounds: null, pointer: null };
const listeners = new Set<() => void>();

function set(next: SnapState) {
  state = next;
  listeners.forEach((l) => l());
}

export function subscribeSnap(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getSnapState(): SnapState {
  return state;
}

/** Drag started inside a lane of this size — show the zone overlay. */
export function beginSnap(bounds: { width: number; height: number }) {
  set({ active: true, bounds, pointer: null });
}

/** Cursor moved (lane-local) — highlight the zone under it. */
export function updateSnap(pointer: { x: number; y: number }) {
  if (!state.active) return;
  set({ ...state, pointer });
}

/**
 * Drop: resolve the target zone from the last cursor position and clear the
 * overlay. Returns the zone rect to snap the window to, or null when there was
 * no lane/pointer (caller keeps the free-dragged position).
 */
export function endSnap(): Zone | null {
  const { active, bounds, pointer } = state;
  set({ active: false, bounds: null, pointer: null });
  if (!active || !bounds || !pointer) return null;
  return resolveZone(pointer, bounds);
}
