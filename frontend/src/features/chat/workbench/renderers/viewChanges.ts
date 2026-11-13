/** Read-only migration diagnostics. Legacy matching never controls rendering. */
import { candidatesFor, getRenderer } from "./legacyViews";
import { viewFor, VIEW_SUFFIXES, extensionRenderers } from "./registry";
import type { RendererExtension } from "../sandbox/rendererExtension";

export interface ViewChange { previous: string; current: string; suggestedPath?: string }
export function viewChange(path: string, content: string, extensions: RendererExtension[], bound?: string): ViewChange | undefined {
  const previous = (bound ? getRenderer(bound, extensions) : undefined) ?? candidatesFor(path, content, extensions)[0];
  const current = viewFor(path, extensions);
  if (!previous || previous.id === current?.id) return undefined;
  const suffixes = previous.source === "builtin"
    ? VIEW_SUFFIXES.find((row) => `builtin:${row.view}` === previous.id)?.suffixes
    : extensionRenderers(extensions).find((row) => row.id === previous.id)?.suffixes;
  const extension = path.match(/\.[^/.]+$/)?.[0].toLowerCase();
  const suffix = suffixes?.find((value) => extension && value.endsWith(extension)) ?? suffixes?.[0];
  const suggested = suffix ? path.replace(/\.[^/.]+$/, "") + suffix : undefined;
  // Reserved/ambiguous extension claims must not promise a view a rename cannot select.
  const suggestedPath = suggested && viewFor(suggested, extensions)?.id === previous.id ? suggested : undefined;
  return { previous: previous.title, current: current?.title ?? "Source", suggestedPath };
}
