import type { ReactNode } from "react";
import type { FsClient } from "./fsClient";

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
