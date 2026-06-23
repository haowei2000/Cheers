import { ResourceError } from "../hooks/useChatRealtime";
import type { FsClient } from "./fsClient";
import { getLens } from "./lens/registry";

// A template = a declarative MANIFEST (pure data). Because it's data — not code —
// a manifest can be loaded at runtime (compiled-in OR dropped into the workspace),
// and it can only reference built-in lenses, which is the safety boundary.
export interface ViewDef {
  id: string;
  title: string;
  file: string; // path in the channel workspace (memory_files)
  lens: string; // a registered lens id ("table" | "kanban" | "markdown" | ...)
  config?: unknown; // lens-specific config (e.g. table columns)
}

export interface TemplateManifest {
  id: string;
  title: string;
  views: ViewDef[];
  seed?: Record<string, unknown>; // path -> initial value (object => JSON, string => text)
}

// Validate an untrusted manifest (e.g. loaded from a workspace file) before use.
// Unknown lenses are rejected so a manifest can never reference UI that doesn't exist.
export function validateManifest(m: unknown): m is TemplateManifest {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.title !== "string" || !Array.isArray(o.views)) return false;
  return (o.views as unknown[]).every((v) => {
    if (!v || typeof v !== "object") return false;
    const vv = v as Record<string, unknown>;
    return (
      typeof vv.id === "string" &&
      typeof vv.title === "string" &&
      typeof vv.file === "string" &&
      typeof vv.lens === "string" &&
      !!getLens(vv.lens)
    );
  });
}

// Scaffold a manifest's starter files. Create-only (if_version=0): re-seeding never
// clobbers data a user/bot already wrote — it just fills the gaps.
export async function seedManifest(fs: FsClient, m: TemplateManifest): Promise<void> {
  for (const [path, value] of Object.entries(m.seed ?? {})) {
    const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    try {
      await fs.write(path, content, 0);
    } catch (e) {
      if (!(e instanceof ResourceError && e.code === "VERSION_CONFLICT")) throw e; // else: exists, keep it
    }
  }
}
