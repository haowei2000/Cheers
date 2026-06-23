import { apiFetch, apiJson } from "@/api/client";
import { validateManifest, type TemplateManifest } from "./manifest";

// Global workbench scenario templates (DATA, no code). An admin installs one and every
// user sees it in the scenario picker. This is the SERVER-LEVEL counterpart to a session
// (temporary) template, which lives only in the browser and never hits this API.
// Distinct from a PLUGIN: a template is inert data (a manifest), so no sandbox is involved.

interface TemplateRow {
  tpl_id: string;
  title: string;
  manifest: unknown;
}

/** Installed global templates (validated; malformed rows are dropped). */
export async function listGlobalTemplates(): Promise<TemplateManifest[]> {
  const rows = await apiJson<TemplateRow[]>("/workbench/templates");
  return rows.map((r) => r.manifest).filter(validateManifest);
}

/** Install/update a global template (admin). The manifest id is the key. */
export async function saveGlobalTemplate(m: TemplateManifest): Promise<void> {
  const res = await apiFetch(`/workbench/templates/${encodeURIComponent(m.id)}`, {
    method: "PUT",
    body: JSON.stringify({ title: m.title, manifest: m }),
  });
  if (!res.ok) throw new Error(`install ${res.status}: ${await res.text()}`);
}

/** Uninstall a global template (admin). */
export async function deleteGlobalTemplate(tplId: string): Promise<void> {
  const res = await apiFetch(`/workbench/templates/${encodeURIComponent(tplId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete ${res.status}: ${await res.text()}`);
}
