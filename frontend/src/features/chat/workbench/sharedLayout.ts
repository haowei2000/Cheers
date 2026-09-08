import { SPAWN_KINDS, type Rect, type SpawnKind } from "./laneSnap";

// The channel's shared arrangement of its lane windows, stored in `.workbench.json`.
//
// Window geometry used to live only in localStorage, keyed per window — device-local,
// so it could not be shared between people and an agent could not write it. Since the
// Workbench is meant to be the channel's shared blackboard (docs/ROADMAP.md), an agent
// that can seed files into it but cannot arrange them is doing half the job.
//
// Two rules make sharing coherent:
//
// 1. **Rects are lane FRACTIONS, never pixels.** Viewers have different lane sizes, and
//    a rect that fits a 1400px lane is nonsense on a 900px one. A fraction resolves
//    against whatever lane the reader actually has.
//
// 2. **A viewer's own drag does not write here.** localStorage geometry is a local
//    override that wins over the shared value until the viewer resets, so nobody's
//    panel moves under their cursor and an agent's arrangement arrives as an offer
//    rather than an interruption. Writing back is explicit ("Save layout for channel").
//
// Rule 2 is also why concurrency is uneventful. Shared writes are rare and
// human-initiated, so the `if_version` CAS with one merge-and-retry in
// `useChannelLayout` is enough; there is no drag storm to coalesce.

/** A rect as fractions of the lane box (0..1), so it survives a different lane size. */
export interface LayoutFraction {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SharedPanelLayout {
  rect?: LayoutFraction;
  /** Whether the channel's layout includes this window. Opening one is inert UI over
   *  data channel-role already governs, so an agent naming it grants no new reach. */
  open?: boolean;
}

export interface SharedWorkspaceLayout {
  /** Right column as a fraction of the available channel width. */
  width: number;
  split: boolean;
  ratio: number;
  active?: SpawnKind;
}

export interface SharedLayout {
  workspace?: SharedWorkspaceLayout;
  version: 1;
  panels: Partial<Record<SpawnKind, SharedPanelLayout>>;
}

const KINDS = new Set<string>(SPAWN_KINDS);

// Four decimals is 0.1px on a 1000px lane — below anything a viewer can see, and it
// keeps `.workbench.json` readable. The file is meant to be hand- and agent-edited, and
// a `0.19999999999999996` that fell out of a clamp reads as a bug in what wrote it.
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function fraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? round(Math.min(Math.max(value, 0), 1)) : null;
}

function parseRect(raw: unknown): LayoutFraction | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const x = fraction(r.x);
  const y = fraction(r.y);
  const w = fraction(r.w);
  const h = fraction(r.h);
  if (x === null || y === null || w === null || h === null) return undefined;
  // A zero-size window is not a placement, it is a mistake — fall through to the
  // spawn placement rather than rendering something nobody can grab.
  if (w <= 0 || h <= 0) return undefined;
  return { x, y, w: round(Math.min(w, 1 - x)), h: round(Math.min(h, 1 - y)) };
}

/** Read the `layout` key of `.workbench.json`.
 *
 * Deliberately tolerant: this file is hand-editable and agent-writable, so a malformed
 * panel is dropped rather than failing the whole read — the window then falls back to
 * its spawn placement, which is what a viewer with no shared layout already gets. */
export function parseLayout(raw: unknown): SharedLayout | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  if (source.version !== 1) return undefined;
  const panels: SharedLayout["panels"] = {};
  const declared = source.panels;
  if (declared && typeof declared === "object") {
    for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
      if (!KINDS.has(key) || !value || typeof value !== "object") continue;
      const panel = value as Record<string, unknown>;
      const entry: SharedPanelLayout = {};
      const rect = parseRect(panel.rect);
      if (rect) entry.rect = rect;
      if (typeof panel.open === "boolean") entry.open = panel.open;
      if (entry.rect || entry.open !== undefined) panels[key as SpawnKind] = entry;
    }
  }
  const rawWorkspace = source.workspace as Record<string, unknown> | undefined;
  const width = rawWorkspace ? fraction(rawWorkspace.width) : null;
  const ratio = rawWorkspace ? fraction(rawWorkspace.ratio) : null;
  const workspace: SharedWorkspaceLayout | undefined =
    width !== null &&
    ratio !== null &&
    typeof rawWorkspace?.split === "boolean"
      ? {
          width,
          ratio,
          split: rawWorkspace.split,
          ...(typeof rawWorkspace.active === "string" &&
          KINDS.has(rawWorkspace.active)
            ? { active: rawWorkspace.active as SpawnKind }
            : {}),
        }
      : undefined;
  return { version: 1, panels, ...(workspace ? { workspace } : {}) };
}

/** Resolve a shared fraction against this viewer's lane box. */
export function toLaneRect(rect: LayoutFraction, bounds: { width: number; height: number }): Rect {
  return {
    x: Math.round(rect.x * bounds.width),
    y: Math.round(rect.y * bounds.height),
    w: Math.round(rect.w * bounds.width),
    h: Math.round(rect.h * bounds.height),
  };
}

/** Express this viewer's pixel rect as a lane fraction, for writing back. */
export function toFraction(rect: Rect, bounds: { width: number; height: number }): LayoutFraction | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const x = round(Math.min(Math.max(rect.x / bounds.width, 0), 1));
  const y = round(Math.min(Math.max(rect.y / bounds.height, 0), 1));
  return {
    x,
    y,
    w: round(Math.min(Math.max(rect.w / bounds.width, 0), 1 - x)),
    h: round(Math.min(Math.max(rect.h / bounds.height, 0), 1 - y)),
  };
}

/** Merge our panels onto whatever is on the server now.
 *
 * Last write wins PER WINDOW rather than per file: two people saving different windows
 * both keep their change, and only a genuine same-window race resolves to one of them.
 * Whole-file replacement would silently drop the other person's save. */
export function mergeLayout(base: SharedLayout | undefined, ours: SharedLayout): SharedLayout {
  const panels = { ...(base?.panels ?? {}) };
  for (const kind of SPAWN_KINDS) {
    const update = ours.panels[kind];
    if (update)
      panels[kind] = update.rect ? update : { ...panels[kind], ...update };
  }
  const workspace = ours.workspace ?? base?.workspace;
  return { version: 1, panels, ...(workspace ? { workspace } : {}) };
}

/** Where a lane window keeps its device-local geometry. One convention, because the
 *  reset below has to clear the same keys `useWindowDrag` writes. */
export function storageKeyFor(kind: SpawnKind): string {
  return `cheers.float.${kind}`;
}

// "Rejoin the channel layout": drop every lane window's local override at once.
//
// A module-level broadcast rather than a prop, for the same reason the z-order and
// occupant registries are: each window owns its own geometry inside its own
// useWindowDrag, and there is no component that holds all four to call reset on.
const resetListeners = new Set<() => void>();
const overrideListeners = new Set<() => void>();

export function requestLayoutReset(): void {
  for (const kind of SPAWN_KINDS) {
    try {
      localStorage.removeItem(storageKeyFor(kind));
    } catch {
      /* private mode — the in-memory reset below still lands */
    }
  }
  resetListeners.forEach((listener) => listener());
  notifyLayoutOverride();
}

export function subscribeLayoutReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

/** A window gained or lost a local override. Fired by the drag hook when it persists
 *  geometry and by the reset above, so the "Reset to channel layout" control can be
 *  offered exactly when it would do something. */
export function notifyLayoutOverride(): void {
  overrideListeners.forEach((listener) => listener());
}

export function subscribeLayoutOverride(listener: () => void): () => void {
  overrideListeners.add(listener);
  return () => {
    overrideListeners.delete(listener);
  };
}

/** Does this device hold geometry of its own for any lane window? */
export function hasLocalOverride(): boolean {
  try {
    return SPAWN_KINDS.some((kind) => localStorage.getItem(storageKeyFor(kind)) != null);
  } catch {
    return false;
  }
}
