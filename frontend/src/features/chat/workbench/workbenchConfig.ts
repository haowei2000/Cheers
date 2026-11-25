export interface WorkbenchSceneState {
  version: 1;
  order: string[];
  titles: Record<string, string>;
  items: Record<string, string[]>;
}

/** Append a tab without disturbing collections or tabs written by another client. */
export function appendCollectionTab(
  state: WorkbenchSceneState | undefined,
  collectionId: string,
  path: string,
): WorkbenchSceneState {
  const current: WorkbenchSceneState = state ?? { version: 1, order: [], titles: {}, items: {} };
  const paths = current.items[collectionId] ?? [];
  if (paths.includes(path)) return current;
  return {
    ...current,
    order: current.order.includes(collectionId) ? [...current.order] : [...current.order, collectionId],
    titles: { ...current.titles },
    items: { ...current.items, [collectionId]: [...paths, path] },
  };
}

export interface WbConfig {
  /** Self-documenting field (regenerated on every write) — for humans/AI reading the file. */
  _doc?: string;
  environment?: string | null;
  pinned?: string[];
  /** Shared navigation index for Collections and Tabs. */
  scene_state?: WorkbenchSceneState;
  /** The channel's shared window arrangement. Owned by `useChannelLayout`, not by this
   *  drawer — carried through the known-keys parse below only so a Workbench write does
   *  not delete a key it has no opinion about. See workbench/sharedLayout.ts. */
  layout?: unknown;
}

// Regenerated into `.workbench.json._doc` on every write, so anyone (human or AI) opening
// the file understands the schema without external docs. NOT a free-form comment — the UI
// rewrites this file, so only fields (like this one) survive; see docs/arch/WORKBENCH.md.
export const WB_DOC =
  "Workbench config (per-channel, maintained by the workbench UI, hand-editable). " +
  "The workbench is content-first: scene_state indexes Collection and Tab navigation while Raw workspace files exposes the complete file tree. " +
  "pinned = files injected into every bot prompt. " +
  "scene_state = enabled Collection order/titles and their file-path Tab indexes (the key name is retained for compatibility); " +
  "layout = the channel's shared window arrangement (rects are fractions of the lane, not pixels); " +
  "File names select views; view settings belong in each file.";

export function sceneBelongsToExtension(sceneId: string, extensionId: string): boolean {
  return sceneId.startsWith(`personal:${extensionId}:`) || sceneId.startsWith(`extension:${extensionId}:`);
}

// Retired views/bindings/configs are ignored; the next write removes them.
export function parseCfg(content: string): WbConfig {
  const raw = JSON.parse(content) as WbConfig;
  return { _doc: raw._doc, environment: raw.environment, pinned: raw.pinned,
    scene_state: raw.scene_state, layout: raw.layout };
}
