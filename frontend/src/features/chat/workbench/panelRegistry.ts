import type { ReactNode } from "react";
import type { FsClient, SendResourceReq } from "./fsClient";
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
  /** Raw resource client (any verb). Used to proxy whitelisted channel.* reads to plugins. */
  sendResourceReq: SendResourceReq;
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
  /** Files surfaced as workbench tabs (the scenario's curated views). In .workbench.json.
   *  `renderer`/`config` are optional: a template migrates its view's lens+config here;
   *  otherwise the file's binding (or default) decides. */
  views: { path: string; title?: string; renderer?: string; config?: unknown }[];
  /** Toggle a file as a workbench tab. */
  toggleView: (path: string, title?: string) => void;
  /** Deep-link target: a file path the File panel should auto-open (e.g. from a
   *  clicked Desk reference in a bot reply). Cleared by the consumer after opening. */
  openTarget?: string | null;
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
