import { ResourceError } from "../hooks/useChatRealtime";
import type { FsClient } from "./fsClient";
import { formatFor, isStructuredPath } from "./jsonFile";
import { getLens } from "./lens/registry";
// side effect: register the built-in lenses. validateManifest gates every view on
// getLens(), so validation must be self-sufficient wherever it's imported — without
// this, a surface that doesn't also import the builtins (e.g. the Settings template
// manager loaded directly) rejects EVERY template as "unknown lens".
import "./lens/builtins";

// A template = a declarative MANIFEST (pure data). Because it's data — not code —
// a manifest can be loaded at runtime (compiled-in OR dropped into the workspace),
// and it can only reference built-in lenses, which is the safety boundary.
/** One item of a scene: where its data lives plus which compiled view renders it.
 *
 * The SAME shape a lane panel has, deliberately — see docs/arch/WORKBENCH.md. It used
 * to be spelled `{file, lens, renderer}` here, `{file, renderer}` in a package, and
 * `{file, lens}` in an official template: three vocabularies for one statement, with a
 * translation at every boundary and a type that carried both `lens` and `renderer`
 * because the round trip could not decide which was canonical. */
export interface PanelDef {
  id: string;
  title: string;
  /** A scene's items always read the channel workspace: `.workbench.json` indexes them
   *  by path on every client, so an item that named a resource verb would have no path
   *  to be indexed by. The source union is shared with lane panels; a scene takes the
   *  fs half of it rather than respelling one. */
  source: { kind: "fs"; path: string };
  /** A renderer reference: "auto" (host picks by content), "builtin:<lens>", or a
   *  resolved "personal:<extension>:<renderer>". Omitted = "auto", matching the
   *  package grammar's default — read it through `viewOf`. */
  view?: string;
  config?: unknown; // view config (e.g. table columns)
}

export const AUTO_VIEW = "auto";

/** An item's view, with the grammar's default applied. */
export function viewOf(item: PanelDef): string {
  return item.view ?? AUTO_VIEW;
}

/** The lens id a `builtin:` view names, or null for `auto` and personal renderers. */
export function builtinLensId(view: string): string | null {
  return view.startsWith("builtin:") ? view.slice("builtin:".length) : null;
}

export interface TemplateManifest {
  id: string;
  title: string;
  items: PanelDef[];
  seed?: Record<string, unknown>; // path -> initial value (object => JSON, string => text)
  // Paths pinned into `.workbench.json.pinned` on activation — their bodies are injected
  // into every bot prompt (the semantic layer). This is how a scenario's convention file
  // reaches the agent without a human pinning it by hand. Keep these files SMALL: pinned
  // bodies ride every prompt and count toward the connector's max_prompt_bytes.
  pin?: string[];
}

// Validate an untrusted manifest (e.g. loaded from a workspace file) before use.
// Unknown lenses are rejected so a manifest can never reference UI that doesn't exist.
export function validateManifest(m: unknown): m is TemplateManifest {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.title !== "string" || !Array.isArray(o.items)) return false;
  if (o.pin !== undefined && !(Array.isArray(o.pin) && (o.pin as unknown[]).every((p) => typeof p === "string"))) return false;
  return (o.items as unknown[]).every((v) => {
    if (!v || typeof v !== "object") return false;
    const item = v as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.title !== "string") return false;
    const source = item.source as Record<string, unknown> | undefined;
    if (!source || source.kind !== "fs" || typeof source.path !== "string" || !source.path) return false;
    // Omitted = "auto": the host picks by content. A named view must resolve to compiled
    // UI, so a manifest can never reference a lens that does not exist. A `personal:`
    // view reaches a sandboxed renderer and is resolved by the renderer registry, not here.
    if (item.view === undefined) return true;
    if (typeof item.view !== "string") return false;
    if (item.view === AUTO_VIEW || item.view.startsWith("personal:")) return true;
    const lens = builtinLensId(item.view);
    return !!lens && !!getLens(lens);
  });
}

// Scaffold a manifest's starter files. Create-only (if_version=0): re-seeding never
// clobbers data a user/bot already wrote — it just fills the gaps. Object seeds
// serialize by the TARGET path's format (a .yaml seed must not get JSON text).
export async function seedManifest(fs: FsClient, m: TemplateManifest): Promise<void> {
  for (const [path, value] of Object.entries(m.seed ?? {})) {
    const content =
      typeof value === "string"
        ? value
        : isStructuredPath(path)
          ? formatFor(path).serialize(value)
          : JSON.stringify(value, null, 2);
    try {
      await fs.write(path, content, 0);
    } catch (e) {
      if (!(e instanceof ResourceError && e.code === "VERSION_CONFLICT")) throw e; // else: exists, keep it
    }
  }
}
