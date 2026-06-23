import type { FsClient } from "./fsClient";
import type { PanelDef } from "./panelRegistry";

// An Environment = a channel "scenario" (the founding Environment-template idea):
//   - panels: which ViewPanels this scenario shows (its Lens set)
//   - seed:   scaffold the scenario's initial files on activation (the "init files" leg)
// Everything it touches is plain files in memory_files (no separate store, no backend).
export interface Environment {
  id: string;
  title: string;
  panels: PanelDef[];
  seed: (fs: FsClient) => Promise<void>;
}

const registry: Environment[] = [];

export function registerEnvironment(env: Environment): void {
  if (!registry.some((e) => e.id === env.id)) registry.push(env);
}

export function getEnvironment(id: string | null | undefined): Environment | undefined {
  return id ? registry.find((e) => e.id === id) : undefined;
}

export function getEnvironments(): Environment[] {
  return registry;
}

// A channel binds to a scenario via a convention file — no schema change.
export const WORKBENCH_CONFIG_PATH = ".workbench.json";
