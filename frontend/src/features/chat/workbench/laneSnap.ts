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
//
// Also owns first-open spawn placement: when a panel opens with no persisted
// geometry, `suggestSpawn` picks a free zone (or fills the lane when alone) so
// every instrument doesn't stack at the same top-left default.

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

/** Instrument identity used to bias first-open placement. */
export type SpawnKind = "workbench" | "viewboard" | "files" | "workspace";

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

/** Full-lane rect (with gap inset) — used when a single instrument owns the lane. */
export function fillLane(bounds: { width: number; height: number }): Rect {
  return {
    x: SNAP_GAP,
    y: SNAP_GAP,
    w: Math.max(0, bounds.width - SNAP_GAP * 2),
    h: Math.max(0, bounds.height - SNAP_GAP * 2),
  };
}

function overlapArea(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

// Kind → preferred zone order within a cols×rows grid (row-major ids z0-0…).
// File-heavy surfaces prefer larger / leading cells; ViewBoard prefers a compact
// trailing cell so it doesn't steal the reading column.
function preferredZoneIndex(kind: SpawnKind, zoneCount: number): number {
  if (zoneCount <= 1) return 0;
  switch (kind) {
    case "workbench":
    case "workspace":
      return 0; // leading / largest reading cell
    case "files":
      return Math.min(1, zoneCount - 1);
    case "viewboard":
      return zoneCount - 1; // trailing glance cell
    default:
      return 0;
  }
}

/**
 * First-open placement for a canvas window. Alone → use its preferred zone so it
 * opens as a movable mini-window instead of covering the workspace. With neighbors
 * → use the freest preferred zone (least overlap). When the
 * lane only has one cell and it's taken, force a vertical split so two panels
 * can coexist on a narrow mid-width desktop.
 */
export function suggestSpawn(
  kind: SpawnKind,
  bounds: { width: number; height: number },
  occupied: Rect[]
): Rect {
  const others = occupied.filter((r) => r.w > 0 && r.h > 0);
  const zones = zonesFor(bounds);
  if (!zones.length) return fillLane(bounds);
  if (others.length === 0) {
    const preferred = zones[preferredZoneIndex(kind, zones.length)] ?? zones[0];
    return { x: preferred.x, y: preferred.y, w: preferred.w, h: preferred.h };
  }

  // Narrow lane with a single cell already taken: invent a top/bottom split so
  // the newcomer isn't buried under the first panel.
  if (zones.length === 1) {
    const halfH = (bounds.height - SNAP_GAP * 3) / 2;
    const top: Rect = {
      x: SNAP_GAP,
      y: SNAP_GAP,
      w: Math.max(0, bounds.width - SNAP_GAP * 2),
      h: Math.max(0, halfH),
    };
    const bot: Rect = {
      x: SNAP_GAP,
      y: SNAP_GAP * 2 + halfH,
      w: Math.max(0, bounds.width - SNAP_GAP * 2),
      h: Math.max(0, halfH),
    };
    const topOverlap = others.reduce((s, o) => s + overlapArea(top, o), 0);
    const botOverlap = others.reduce((s, o) => s + overlapArea(bot, o), 0);
    // File-heavy surfaces prefer the larger reading band (top); glance panels the bottom.
    if (kind === "viewboard") return botOverlap <= topOverlap ? bot : top;
    return topOverlap <= botOverlap ? top : bot;
  }

  const pref = preferredZoneIndex(kind, zones.length);
  // Score: lower overlap is better; prefer the kind's preferred index as a tiebreak.
  let best = zones[pref] ?? zones[0];
  let bestScore = Infinity;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    const overlap = others.reduce((sum, o) => sum + overlapArea(z, o), 0);
    const bias = Math.abs(i - pref) * 0.01; // tiny — only breaks ties
    const score = overlap + bias;
    if (score < bestScore) {
      bestScore = score;
      best = z;
    }
  }
  return { x: best.x, y: best.y, w: best.w, h: best.h };
}

// Recommended lane widths (px) when opening a file-heavy instrument. ChannelView
// expands the lane toward these so a fresh Workbench isn't crushed beside chat.
export const LANE_TARGET: Record<SpawnKind, number> = {
  workbench: 600,
  workspace: 720,
  files: 520,
  viewboard: 420,
};

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

// ── live occupant registry (for spawn placement) ───────────────────────────
// Each open floating window publishes its lane-local rect here so a newly opened
// sibling can avoid stacking on top of it. Closed / unmounted windows clear.
const occupants = new Map<string, Rect>();
const occupantListeners = new Set<() => void>();

function notifyOccupants() {
  occupantListeners.forEach((l) => l());
}

export function subscribeOccupants(l: () => void): () => void {
  occupantListeners.add(l);
  return () => {
    occupantListeners.delete(l);
  };
}

export function setOccupant(key: string, rect: Rect | null) {
  if (rect == null || rect.w <= 0 || rect.h <= 0) {
    if (!occupants.has(key)) return;
    occupants.delete(key);
    notifyOccupants();
    return;
  }
  const prev = occupants.get(key);
  if (prev && prev.x === rect.x && prev.y === rect.y && prev.w === rect.w && prev.h === rect.h) {
    return;
  }
  occupants.set(key, rect);
  notifyOccupants();
}

export function getOccupants(exceptKey?: string): Rect[] {
  const out: Rect[] = [];
  for (const [k, r] of occupants) {
    if (exceptKey && k === exceptKey) continue;
    out.push(r);
  }
  return out;
}

/** True when `rect` claims most of the lane (a prior alone-fill spawn). */
export function isNearlyFill(
  rect: Rect,
  bounds: { width: number; height: number },
  ratio = 0.85
): boolean {
  const fill = fillLane(bounds);
  return rect.w >= fill.w * ratio && rect.h >= fill.h * ratio;
}
