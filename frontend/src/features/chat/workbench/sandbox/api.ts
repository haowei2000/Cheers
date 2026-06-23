import { apiFetch, apiJson } from "@/api/client";

export interface PluginMeta {
  plugin_id: string;
  title: string;
  manifest: { id?: string; title?: string; panels?: { id: string; title: string }[] };
}

/** Installed server-level plugins (metadata; bundles fetched lazily per panel). */
export function listPlugins(): Promise<PluginMeta[]> {
  return apiJson<PluginMeta[]>("/workbench/plugins");
}

/** The sandboxed HTML bundle for a plugin (fetched WITH auth, then set as iframe srcDoc —
 *  an iframe `src` can't carry the Bearer token, so we fetch + srcDoc). */
export async function fetchBundle(pluginId: string): Promise<string> {
  const res = await apiFetch(`/workbench/plugins/${encodeURIComponent(pluginId)}/bundle`);
  if (!res.ok) throw new Error(`bundle ${res.status}`);
  return res.text();
}

/** Admin-only install/update of a plugin (manifest + sandboxed bundle). */
export async function installPlugin(input: {
  id: string;
  title: string;
  manifest: unknown;
  bundle: string;
}): Promise<void> {
  const res = await apiFetch(`/workbench/plugins/${encodeURIComponent(input.id)}`, {
    method: "PUT",
    body: JSON.stringify({ title: input.title, manifest: input.manifest, bundle: input.bundle }),
  });
  if (!res.ok) throw new Error(`install ${res.status}: ${await res.text()}`);
}
