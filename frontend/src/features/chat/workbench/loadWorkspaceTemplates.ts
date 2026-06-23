import type { FsClient } from "./fsClient";
import { validateManifest, type TemplateManifest } from "./manifest";

const TEMPLATES_DIR = ".workbench/templates";

// Runtime plugin loading: any *.json manifest dropped into `.workbench/templates/` in
// a channel's workspace is loaded and validated here. This is safe "plugin loading"
// because a manifest is DATA (no executable code) and can only reference built-in
// lenses — so dropping a JSON file adds a scenario WITHOUT a rebuild, with no code
// execution. Malformed / unknown-lens manifests are skipped with a console warning.
export async function loadWorkspaceTemplates(fs: FsClient): Promise<TemplateManifest[]> {
  let entries;
  try {
    entries = (await fs.ls(TEMPLATES_DIR)).entries;
  } catch {
    return []; // dir doesn't exist => no workspace templates
  }

  const out: TemplateManifest[] = [];
  for (const e of entries.filter((x) => !x.is_dir && x.path.endsWith(".json"))) {
    try {
      const f = await fs.read(e.path);
      const m: unknown = JSON.parse(f.content);
      if (validateManifest(m)) out.push(m);
      else console.warn(`[workbench] skipped invalid template manifest: ${e.path}`);
    } catch (err) {
      console.warn(`[workbench] failed to load template ${e.path}:`, err);
    }
  }
  return out;
}
