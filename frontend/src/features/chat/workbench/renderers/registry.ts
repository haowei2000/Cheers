import table from "../../../../../../shared/view-suffixes.json";
import type { RendererExtension } from "../sandbox/rendererExtension";

export interface RendererDesc {
  id: string;
  title: string;
  source: "builtin" | "extension";
  suffixes: string[];
  lensId?: string;
  extensionId?: string;
  rendererId?: string;
}

export const VIEW_SUFFIXES = table;
const BUILTINS: RendererDesc[] = table.filter((row) => !["image", "pdf"].includes(row.view)).map((row) => ({
  id: `builtin:${row.view}`, title: row.title, source: "builtin", lensId: row.view, suffixes: row.suffixes,
}));

export function extensionRenderers(extensions: RendererExtension[]): RendererDesc[] {
  return extensions.flatMap((extension) => (extension.manifest.renderers ?? []).map((renderer) => ({
    id: `personal:${extension.extensionId}:${renderer.id}`, title: renderer.title,
    source: "extension" as const, extensionId: extension.extensionId, rendererId: renderer.id,
    suffixes: !Array.isArray(renderer.match) && renderer.match?.suffix ? [renderer.match.suffix.toLowerCase()] : [],
  })));
}

/** Built-in suffixes are reserved. Duplicate extension claims are disabled, rather
 * than choosing a renderer based on installation order. Longest suffix wins. */
export function viewFor(path: string, extensions: RendererExtension[] = []): RendererDesc | undefined {
  const name = path.split("/").pop()!.toLowerCase();
  const reserved = new Set(table.flatMap((row) => row.suffixes));
  const custom = extensionRenderers(extensions);
  const counts = new Map<string, number>();
  for (const renderer of custom) for (const suffix of renderer.suffixes) counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
  return [...BUILTINS, ...custom].flatMap((renderer) => renderer.suffixes
    .filter((suffix) => name.endsWith(suffix) && (renderer.source === "builtin" || (!reserved.has(suffix) && counts.get(suffix) === 1)))
    .map((suffix) => ({ renderer, length: suffix.length })))
    .sort((a, b) => b.length - a.length)[0]?.renderer;
}

export function builtinView(path: string): string | undefined {
  const name = path.split("/").pop()!.toLowerCase();
  return table.flatMap((row) => row.suffixes.filter((suffix) => name.endsWith(suffix)).map((suffix) => ({ view: row.view, length: suffix.length })))
    .sort((a, b) => b.length - a.length)[0]?.view;
}

export function canDiscover(path: string, extensions: RendererExtension[]): boolean {
  return !!viewFor(path, extensions);
}
export function getRenderer(id: string, extensions: RendererExtension[]): RendererDesc | undefined {
  return [...BUILTINS, ...extensionRenderers(extensions)].find((renderer) => renderer.id === id);
}
