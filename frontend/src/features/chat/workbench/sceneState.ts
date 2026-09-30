import { createElement, type ComponentType } from "react";
import {
  Atom,
  Boxes,
  CalendarCheck,
  CheckSquare2,
  Code2,
  FileText,
  Folder,
  Server,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { AddContextIcon, CollectionIcon } from "@/components/ui/editorial-icons";
import type { ContextAction } from "@/components/ui/context-actions";
import type { TemplateManifest } from "./manifest";
import type { WorkbenchSceneState } from "./WorkbenchDrawer";
import type { WorkbenchContext } from "./context";
import { getRenderer, previewOptions, type RendererDesc } from "./renderers/registry";
import type { FsEntry } from "./fsClient";

export const OTHER_SCENE = "__other__";
export const CANVAS_SCENE = "canvas:";

export const canvasSceneId = (path: string) => `${CANVAS_SCENE}${path}`;
export const canvasScenePath = (id: string) => (id.startsWith(CANVAS_SCENE) ? id.slice(CANVAS_SCENE.length) : null);
export const isCanvasPath = (path: string) => /\.canvas\.(ya?ml|json)$/i.test(path);

export function canAddTabToCollection(state: WorkbenchSceneState, collectionId: string): boolean {
  return collectionId !== OTHER_SCENE && !canvasScenePath(collectionId) && state.order.includes(collectionId);
}

export function unclaimedRenderableTabs(paths: string[], state: WorkbenchSceneState): string[] {
  const claimed = new Set(state.order.flatMap((id) => state.items[id] ?? []));
  return paths.filter((path) => !claimed.has(path) && !isCanvasPath(path)).sort((a, b) => a.localeCompare(b));
}

export type SceneIconComponent = typeof Code2 | ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export const sceneMeta: Record<string, { subtitle: string; Icon: SceneIconComponent; color: string }> = {
  "cheers-code-project": { subtitle: "Plan, fix, and ship", Icon: Code2, color: "text-accent-300" },
  "cheers-research-lab": { subtitle: "Experiments and submissions", Icon: Atom, color: "text-research-300" },
  "cheers-task-board": { subtitle: "Turn intent into progress", Icon: CheckSquare2, color: "text-info-300" },
  "cheers-team-ops": { subtitle: "Systems and ownership", Icon: Server, color: "text-warning-300" },
  "notes-workflow": { subtitle: "Focused notes & review", Icon: FileText, color: "text-accent-300" },
  "research-planner": { subtitle: "Deadlines and risk tracking", Icon: CalendarCheck, color: "text-research-300" },
  [OTHER_SCENE]: { subtitle: "Renderable tabs outside Collections", Icon: Boxes, color: "text-category-300" },
};

export function getCoreExtensionId(id: string): string {
  if (id.startsWith("extension:") || id.startsWith("personal:")) {
    const parts = id.split(":");
    return parts[1] || id;
  }
  return id;
}

export function createPackageIcon(iconUrl: string): SceneIconComponent {
  return function PackageIcon({ className, "aria-hidden": ariaHidden }: { className?: string; "aria-hidden"?: boolean | "true" | "false" }) {
    return createElement("img", {
      src: iconUrl,
      className: cn("h-4 w-4 object-contain", className),
      alt: "",
      "aria-hidden": ariaHidden ?? "true",
    });
  };
}

export function metaFor(id: string, iconUrl?: string): { subtitle: string; Icon: SceneIconComponent; color: string } {
  if (iconUrl) {
    return {
      subtitle: "Extension template",
      Icon: createPackageIcon(iconUrl),
      color: "",
    };
  }
  const coreId = getCoreExtensionId(id);
  const found = sceneMeta[id] ?? sceneMeta[coreId];
  if (found) return found;
  return { subtitle: "Native workspace", Icon: CollectionIcon as unknown as SceneIconComponent, color: "text-content-secondary" };
}

export function sceneTabContextActions(
  label: string,
  onSelect: () => void,
  onShowRaw: () => void,
  onAddToContext: () => void,
  contextAdded = false,
  contextAvailable = true,
): ContextAction[] {
  return [
    {
      id: "open-collection",
      label: `Open ${label}`,
      icon: createElement(CollectionIcon, { className: "h-4 w-4" }),
      run: onSelect,
    },
    {
      id: "add-context",
      label: !contextAvailable
        ? "No Collection files to add"
        : contextAdded
          ? "Already added to context"
          : "Add Collection to context",
      icon: createElement(AddContextIcon, { className: "h-4 w-4" }),
      disabled: !contextAvailable || contextAdded,
      group: "secondary",
      run: onAddToContext,
    },
    {
      id: "raw",
      label: "Raw",
      icon: createElement(Folder, { className: "h-4 w-4" }),
      group: "secondary",
      run: onShowRaw,
    },
  ];
}

export function basename(path: string) {
  return path.split("/").pop() ?? path;
}

export function fallbackItemTitle(path: string) {
  const name = basename(path);
  return name.replace(/\.(json|ya?ml|toml|md|markdown|canvas\.(ya?ml|json))$/i, "");
}

export function reconcileSceneItems(
  sceneState: WorkbenchSceneState | undefined,
  templates: TemplateManifest[],
  legacyEnvironment?: string | null
): WorkbenchSceneState {
  const order = sceneState?.order?.length
    ? [...sceneState.order]
    : legacyEnvironment
      ? [legacyEnvironment]
      : [];
  const titles = { ...(sceneState?.titles ?? {}) };
  const items = Object.fromEntries(
    Object.entries(sceneState?.items ?? {}).map(([id, paths]) => [id, [...paths]])
  );
  for (const id of order) {
    const template = templates.find((candidate) => candidate.id === id);
    if (!template) continue;
    titles[id] ??= template.title;
    const paths = items[id] ?? [];
    for (const item of template.items) if (!paths.includes(item.source.path)) paths.push(item.source.path);
    items[id] = paths;
  }
  return { version: 1, order, titles, items };
}

export function itemTitle(sceneId: string, path: string, templates: TemplateManifest[]) {
  return (
    templates
      .find((template) => template.id === sceneId)
      ?.items.find((item) => item.source.path === path)?.title ?? fallbackItemTitle(path)
  );
}

export function rendererFor(
  path: string,
  content: string | undefined,
  ctx: WorkbenchContext,
  failed: string[] = []
): RendererDesc | undefined {
  if (content === undefined) {
    const bound = ctx.bindings[path] ? getRenderer(ctx.bindings[path], ctx.rendererExtensions) : undefined;
    return bound && !failed.includes(bound.id) ? bound : undefined;
  }
  return previewOptions(path, content, ctx.rendererExtensions, ctx.bindings[path], failed)[0];
}

export async function readDiscoverableFiles(
  entries: FsEntry[],
  ctx: WorkbenchContext,
  onBatch: (values: Record<string, string>) => void
) {
  const candidates = entries.filter((entry) => {
    if (entry.is_dir || entry.path === ".workbench.json") return false;
    if (ctx.bindings[entry.path] && getRenderer(ctx.bindings[entry.path], ctx.rendererExtensions)) return false;
    return /\.(md|markdown|json|ya?ml)$/i.test(entry.path);
  });
  for (let start = 0; start < candidates.length; start += 4) {
    const batch = candidates.slice(start, start + 4);
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          return [entry.path, (await ctx.fs.read(entry.path)).content] as const;
        } catch {
          return null;
        }
      })
    );
    onBatch(Object.fromEntries(results.filter((value): value is readonly [string, string] => value !== null)));
  }
}
