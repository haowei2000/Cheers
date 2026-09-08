import { SPAWN_KINDS, type SpawnKind } from "./laneSnap";

export const MESSAGE_MIN_WIDTH = 480;
export const PANEL_MIN_WIDTH = 320;
export const WORKSPACE_GAP = 8;

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
  return {
    width: source.width as number,
    split: source.split === true,
    ratio: Math.max(0.25, Math.min(0.75, source.ratio as number)),
    ...(active ? { active } : {}),
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
    overridden: saved !== null,
  };
}

export function canSplitWorkspace(
  stageHeight: number,
  panelCount: number,
): boolean {
  return panelCount > 1 && stageHeight >= 488;
}
