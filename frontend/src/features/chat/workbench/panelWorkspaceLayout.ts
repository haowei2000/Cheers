import { SPAWN_KINDS, type Rect, type SpawnKind } from "./laneSnap";

export const MESSAGE_MIN_WIDTH = 480;
export const PANEL_MIN_WIDTH = 320;
export const WORKSPACE_GAP = 8;

export function workspacePreferenceKey(channelId: string): string {
  return `cheers.panel-workspace.${channelId}`;
}

type LaneBox = { left: number; top: number };

/** Managed panels use viewport-fixed CSS while shared layout uses lane-relative pixels. */
export function toViewportRect(rect: Rect, lane: LaneBox): Rect {
  return { ...rect, x: lane.left + rect.x, y: lane.top + rect.y };
}

/** Convert managed viewport geometry back to the lane coordinate system before saving. */
export function toLaneRelativeRect(rect: Rect, lane: LaneBox): Rect {
  return { ...rect, x: rect.x - lane.left, y: rect.y - lane.top };
}

export function resolveWorkspaceLayout(width: number, requested: number) {
  const sideBySide =
    width >= MESSAGE_MIN_WIDTH + PANEL_MIN_WIDTH + WORKSPACE_GAP;
  return {
    sideBySide,
    panelWidth: sideBySide
      ? Math.min(
          Math.max(PANEL_MIN_WIDTH, requested),
          width - MESSAGE_MIN_WIDTH - WORKSPACE_GAP,
        )
      : width,
  };
}

export interface LocalWorkspacePreference {
  width: number;
  split: boolean;
  ratio: number;
  active?: SpawnKind;
  floats: Partial<Record<SpawnKind, Rect>>;
}

export interface RestoredWorkspacePreference extends LocalWorkspacePreference {
  overridden: boolean;
}

export function parseLocalWorkspacePreference(
  value: unknown,
): LocalWorkspacePreference | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!Number.isFinite(source.width) || !Number.isFinite(source.ratio)) return null;
  const active =
    typeof source.active === "string" &&
    (SPAWN_KINDS as readonly string[]).includes(source.active)
      ? (source.active as SpawnKind)
      : undefined;
  const floats: Partial<Record<SpawnKind, Rect>> = {};
  if (source.floats && typeof source.floats === "object") {
    for (const [kind, value] of Object.entries(source.floats as Record<string, unknown>)) {
      if (!(SPAWN_KINDS as readonly string[]).includes(kind) || !value || typeof value !== "object")
        continue;
      const rect = value as Record<string, unknown>;
      if (
        Number.isFinite(rect.x) &&
        Number.isFinite(rect.y) &&
        Number.isFinite(rect.w) &&
        Number.isFinite(rect.h) &&
        (rect.w as number) > 0 &&
        (rect.h as number) > 0
      )
        floats[kind as SpawnKind] = {
          x: rect.x as number,
          y: rect.y as number,
          w: rect.w as number,
          h: rect.h as number,
        };
    }
  }
  return {
    width: source.width as number,
    split: source.split === true,
    ratio: Math.max(0.25, Math.min(0.75, source.ratio as number)),
    ...(active ? { active } : {}),
    floats,
  };
}

export function restoreLocalWorkspacePreference(
  raw: string | null,
  fallbackActive: SpawnKind,
): RestoredWorkspacePreference {
  let saved: LocalWorkspacePreference | null = null;
  try {
    saved = parseLocalWorkspacePreference(JSON.parse(raw ?? "null"));
  } catch {
    // A hand-edited or stale local value must reset every channel-scoped field.
  }
  return {
    width: saved?.width ?? 400,
    split: saved?.split ?? false,
    ratio: saved?.ratio ?? 0.5,
    active: saved?.active ?? fallbackActive,
    floats: saved?.floats ?? {},
    overridden: saved !== null,
  };
}

export function canSplitWorkspace(
  stageHeight: number,
  panelCount: number,
): boolean {
  return panelCount > 1 && stageHeight >= 488;
}
