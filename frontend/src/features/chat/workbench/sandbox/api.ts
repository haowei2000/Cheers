import { apiFetch, apiJson } from "@/api/client";
import { validatePluginManifest, type PluginManifest, type PluginMeta } from "./pluginManifest";

// Manifest types + validation live in ./pluginManifest (dependency-free, unit-testable);
// re-exported here so consumers keep one import site for everything plugin-related.
export {
  MAX_PLUGIN_BUNDLE_BYTES,
  validatePluginManifest,
  type PluginManifest,
  type PluginMeta,
  type RendererMatch,
} from "./pluginManifest";

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

/** Extract the embedded manifest from an uploaded plugin .html (the
 *  `<script type="application/json" id="cheers-plugin">…</script>` block). DOMParser
 *  does NOT execute scripts, so reading an untrusted bundle here is inert. */
export function parsePluginHtml(html: string): { id: string; title: string; manifest: PluginManifest } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const el = doc.querySelector("#cheers-plugin");
  if (!el || !el.textContent) {
    throw new Error('Missing embedded manifest: <script type="application/json" id="cheers-plugin">');
  }
  const manifest = JSON.parse(el.textContent) as PluginManifest;
  const err = validatePluginManifest(manifest);
  if (err) throw new Error(`Invalid plugin manifest: ${err}`);
  return { id: manifest.id!, title: manifest.title!, manifest };
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

/** Admin-only uninstall of a plugin. */
export async function deletePlugin(pluginId: string): Promise<void> {
  const res = await apiFetch(`/workbench/plugins/${encodeURIComponent(pluginId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete ${res.status}: ${await res.text()}`);
}
