import type { ReactNode } from "react";
import type { FsClient } from "./fsClient";
import type { PluginMeta } from "./sandbox/api";

// The frontend "plugin" seam (the locked model's Environment/Lens idea): a
// workbench panel = a ViewPanel over the channel workspace. A plugin registers a
// PanelDef; the workbench shell mounts registered panels as tabs. v1 ships the
// File panel as the only built-in; a Context panel registers the same way later.
//
// This registry is intentionally a *frontend* convention, NOT a backend isolation
// contract — the backend seam is just resource verbs (fs.*) gated by channel-role.

export interface PanelContext {
  channelId: string;
  fs: FsClient;
  /** Paths pinned to every bot prompt (the semantic layer — e.g. a prompt template). */
  pinned: string[];
  /** Pin / unpin a file path (persisted in .workbench.json). */
  togglePin: (path: string) => void;
  /** Installed server-level renderer plugins (the renderer picker's candidate source). */
  plugins: PluginMeta[];
  /** path -> renderer id: which renderer opens a file. Persisted in .workbench.json. */
  bindings: Record<string, string>;
  /** Set (or clear, with null) a file's renderer binding. */
  setBinding: (path: string, rendererId: string | null) => void;
  /** Files surfaced as workbench tabs (the scenario's curated views). In .workbench.json. */
  views: { path: string; title?: string }[];
  /** Toggle a file as a workbench tab. */
  toggleView: (path: string, title?: string) => void;
}

export interface PanelDef {
  id: string;
  title: string;
  render: (ctx: PanelContext) => ReactNode;
}

const registry: PanelDef[] = [];

export function registerPanel(def: PanelDef): void {
  if (!registry.some((p) => p.id === def.id)) registry.push(def);
}

export function getPanels(): PanelDef[] {
  return registry;
}
