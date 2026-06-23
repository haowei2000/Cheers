import { apiFetch, apiJson } from "@/api/client";

// What a renderer ACCEPTS — declared by the renderer, evaluated cheaply by the host to
// build the candidate list (no plugin boot). A renderer is offered for a file only if
// its content passes this. The fine "can I really render this" judgment still happens
// inside the renderer at render time (it may reply cheers:unsupported).
export interface RendererMatch {
  format?: string; // "markdown" | "json" | "toml" | "xml" | "text" (by file extension)
  glob?: string; // optional path glob, e.g. "reviews/*.md"
  requireAll?: string[]; // content must contain ALL of these substrings (e.g. md headings)
  requireAny?: string[]; // content must contain AT LEAST ONE of these
  jsonHas?: string[]; // json only: parsed object must have ALL these top-level keys
}

export interface PluginMeta {
  plugin_id: string;
  title: string;
  manifest: {
    id?: string;
    title?: string;
    // renderer plugins declare renderers (render/save protocol, SandboxRenderer). The old
    // `panels` scenario-plugin protocol is retired; an installed plugin without `renderers`
    // simply contributes nothing.
    renderers?: { id: string; title: string; match?: RendererMatch }[];
  };
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

/** Extract the embedded manifest from an uploaded plugin .html (the
 *  `<script type="application/json" id="cheers-plugin">…</script>` block). DOMParser
 *  does NOT execute scripts, so reading an untrusted bundle here is inert. */
export function parsePluginHtml(html: string): { id: string; title: string; manifest: unknown } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const el = doc.querySelector("#cheers-plugin");
  if (!el || !el.textContent) {
    throw new Error('缺少内嵌 manifest：<script type="application/json" id="cheers-plugin">');
  }
  const manifest = JSON.parse(el.textContent) as { id?: string; title?: string };
  if (!manifest.id || !manifest.title) throw new Error("manifest 缺 id 或 title");
  return { id: manifest.id, title: manifest.title, manifest };
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
