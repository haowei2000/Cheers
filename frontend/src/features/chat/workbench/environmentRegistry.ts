import type { TemplateManifest } from "./manifest";

// Built-in templates are registered here at import time (compiled in). GLOBAL templates
// (admin-installed, server-level) and SESSION templates (temporarily uploaded) are fetched
// at runtime by the workbench and merged in there — they are NOT added to this registry.
const registry: TemplateManifest[] = [];

export function registerEnvironment(m: TemplateManifest): void {
  if (!registry.some((e) => e.id === m.id)) registry.push(m);
}

export function getBuiltinEnvironments(): TemplateManifest[] {
  return registry;
}

// A channel binds to a template via this convention file — no schema change.
export const WORKBENCH_CONFIG_PATH = ".workbench.json";
