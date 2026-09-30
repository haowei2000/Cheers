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
  /** path -> renderer id: which renderer Preview uses for a file. */
  bindings?: Record<string, string>;
  /** path -> lens config (e.g. table columns); written create-only by scenario activation. */
  configs?: Record<string, unknown>;
  /** Shared navigation index for native multi-scene clients. Renderer selection remains
   * file-bound through bindings; this does not resurrect template-owned renderers. */
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
  "bindings = file path → renderer id Preview uses (unbound: best content match, else raw); " +
  "configs = file path → lens config (e.g. table columns), written by scenario activation; " +
  "pinned = files injected into every bot prompt. " +
  "scene_state = enabled Collection order/titles and their file-path Tab indexes (the key name is retained for compatibility); " +
  "layout = the channel's shared window arrangement (rects are fractions of the lane, not pixels); " +
  "Files themselves are pure content — how a file renders is decided by this config, never written into the file.";

export function sceneBelongsToExtension(sceneId: string, extensionId: string): boolean {
  return sceneId.startsWith(`personal:${extensionId}:`) || sceneId.startsWith(`extension:${extensionId}:`);
}

// Known-keys parse + one-time migration: the retired `views` tab list carried each
// scenario view's renderer/config — collapse those into bindings/configs (create-only,
// an explicit binding wins) so pre-refactor channels keep their table/kanban previews.
// The migrated result persists on the next write; the `views` key itself retires.
export function parseCfg(content: string): WbConfig {
  const raw = JSON.parse(content) as WbConfig & {
    views?: { path?: string; renderer?: string; config?: unknown }[];
  };
  const cfg: WbConfig = {
    _doc: raw._doc,
    environment: raw.environment,
    pinned: raw.pinned,
    bindings: raw.bindings
      ? Object.fromEntries(Object.entries(raw.bindings).filter(([, renderer]) => renderer.startsWith("builtin:")))
      : undefined,
    configs: raw.configs,
    scene_state: raw.scene_state,
    layout: raw.layout,
  };
  if (raw.views?.length) {
    const b = { ...(cfg.bindings ?? {}) };
    const c = { ...(cfg.configs ?? {}) };
    for (const v of raw.views) {
      if (!v?.path || !v.renderer) continue;
      if (!b[v.path]) b[v.path] = v.renderer;
      if (v.config !== undefined && c[v.path] === undefined) c[v.path] = v.config;
    }
    cfg.bindings = b;
    cfg.configs = c;
  }
  return cfg;
}
