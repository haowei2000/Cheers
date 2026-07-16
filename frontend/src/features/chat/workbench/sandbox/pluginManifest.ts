// Plugin manifest types + shape validation. Deliberately dependency-free (no DOM, no
// api client) so it is unit-testable in node and shared by every manifest consumer:
// the admin upload, the drawer's temporary (session) load, and the renderer registry.

/** The protocol version this host implements (manifest `protocol` field). A manifest
 *  without `protocol` defaults to 1 — the documented default covering every plugin
 *  installed before the field existed. Hosts skip plugins declaring a HIGHER protocol
 *  (they'd speak messages we don't) instead of half-rendering them. */
export const PLUGIN_PROTOCOL = 1;

// What a renderer ACCEPTS — declared by the renderer, evaluated cheaply by the host to
// build the candidate list (no plugin boot). A renderer is offered for a file only if
// its content passes this. The fine "can I really render this" judgment still happens
// inside the renderer at render time (it may reply cheers:unsupported).
// Hosts ignore unknown match keys, so this vocabulary can grow within protocol 1.
export interface RendererMatch {
  /** Coarse format(s) by file extension: "markdown" | "json" | "toml" | "xml" | "text".
   *  A single string or a list; "text" is the catch-all (matches any path). */
  format?: string | string[];
  glob?: string; // optional path glob, e.g. "reviews/*.md"
  requireAll?: string[]; // content must contain ALL of these substrings (e.g. md headings)
  requireAny?: string[]; // content must contain AT LEAST ONE of these
  /** Parsed STRUCTURED content (json today, yaml when supported) must have ALL these
   *  top-level keys. Successor of jsonHas — prefer this. */
  dataHas?: string[];
  /** Top-level shape of parsed structured content. The only way to claim "a JSON/YAML
   *  array" (dataHas can't — arrays have no keys). */
  dataKind?: "object" | "array";
  /** DEPRECATED alias of dataHas with frozen JSON-ONLY semantics (never matches yaml).
   *  Valid forever under protocol 1; new manifests should use dataHas. */
  jsonHas?: string[];
}

export interface PluginManifest {
  id?: string;
  title?: string;
  /** Protocol version (see PLUGIN_PROTOCOL). Absent = 1. */
  protocol?: number;
  // renderer plugins declare renderers (render/save protocol, SandboxRenderer). The old
  // `panels` scenario-plugin protocol is retired; an installed plugin without `renderers`
  // simply contributes nothing.
  renderers?: { id: string; title: string; match?: RendererMatch }[];
}

export interface PluginMeta {
  plugin_id: string;
  title: string;
  manifest: PluginManifest;
  /** Inline sandbox bundle — present only on SESSION-loaded (temporary) plugins; the
   *  server never sends it (installed bundles are fetched lazily via fetchBundle). */
  bundle?: string;
  /** Session-only marker (loaded via the drawer, never installed) — ⏱ in pickers. */
  transient?: boolean;
}

/** Upper bound for a plugin bundle, in UTF-8 bytes. Client-side cap for session
 *  (temporary) loads, matching the cap the server will enforce at install (lands with
 *  server-side install validation). Also the sane ceiling for iframe srcDoc. */
export const MAX_PLUGIN_BUNDLE_BYTES = 2 * 1024 * 1024;

/** Shape-check a parsed plugin manifest. Returns an error message, or null when valid. */
export function validatePluginManifest(m: unknown): string | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "manifest must be a JSON object";
  const o = m as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) return "manifest.id must be a non-empty string";
  if (typeof o.title !== "string" || !o.title.trim()) return "manifest.title must be a non-empty string";
  if (o.protocol !== undefined && o.protocol !== PLUGIN_PROTOCOL)
    return `unsupported protocol ${JSON.stringify(o.protocol)} (this host implements protocol ${PLUGIN_PROTOCOL}; omit the field or set ${PLUGIN_PROTOCOL})`;
  if ("panels" in o)
    return "legacy scenario-plugin manifest (`panels`): that protocol is retired — declare renderers[] instead; see docs/developer/PLUGIN_DEVELOPMENT.md";
  if (!Array.isArray(o.renderers) || o.renderers.length === 0)
    return "manifest.renderers must be a non-empty array";
  const seen = new Set<string>();
  for (const r of o.renderers as unknown[]) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return "each renderer must be an object";
    const rr = r as Record<string, unknown>;
    if (typeof rr.id !== "string" || !rr.id.trim()) return "each renderer needs a non-empty string id";
    if (typeof rr.title !== "string" || !rr.title.trim()) return "each renderer needs a non-empty string title";
    if (seen.has(rr.id)) return `duplicate renderer id: ${rr.id}`;
    seen.add(rr.id);
    if (rr.match !== undefined && (!rr.match || typeof rr.match !== "object" || Array.isArray(rr.match)))
      return "renderer match must be an object when present";
  }
  return null;
}
