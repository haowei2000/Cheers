import { Button as UiButton } from "@/components/ui/button";
import { Select as UiSelect } from "@/components/ui/select";
import { Tip } from "@/components/ui/tip";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Atom,
  Boxes,
  CheckSquare2,
  Code2,
  FileQuestion,
  FolderPlus,
  LayoutGrid,
  Server,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { WorkbenchContext } from "./context";
import type { FsEntry } from "./fsClient";
import type { TemplateManifest } from "./manifest";
import { RendererHost } from "./renderers/RendererHost";
import { candidatesFor, getRenderer, type RendererDesc } from "./renderers/registry";
import type { WorkbenchSceneState } from "./WorkbenchDrawer";

const OTHER_SCENE = "__other__";

const sceneMeta: Record<string, { subtitle: string; Icon: typeof Code2; color: string }> = {
  "cheers-code-project": { subtitle: "Plan, fix, and ship", Icon: Code2, color: "text-indigo-300" },
  "cheers-research-lab": { subtitle: "Experiments and submissions", Icon: Atom, color: "text-violet-300" },
  "cheers-task-board": { subtitle: "Turn intent into progress", Icon: CheckSquare2, color: "text-sky-300" },
  "cheers-team-ops": { subtitle: "Systems and ownership", Icon: Server, color: "text-amber-300" },
  [OTHER_SCENE]: { subtitle: "Renderable items outside scenes", Icon: Boxes, color: "text-teal-300" },
};

function metaFor(id: string) {
  return sceneMeta[id] ?? { subtitle: "Native workspace", Icon: LayoutGrid, color: "text-zinc-200" };
}

function AddSceneControl({
  available,
  onSelect,
}: {
  available: TemplateManifest[];
  onSelect: (manifest: TemplateManifest) => void;
}) {
  if (available.length === 0) return null;

  return (
    <div className="relative flex-shrink-0">
      <FolderPlus
        className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-zinc-200"
        aria-hidden="true"
      />
      <Tip content="Add a scene" align="end">
        <UiSelect
          aria-label="Add scene"
          title="Add scene"
          defaultValue=""
          onChange={(event) => {
            const manifest = available.find((candidate) => candidate.id === event.target.value);
            if (manifest) onSelect(manifest);
            event.currentTarget.value = "";
          }}
          controlSize="regular"
          controlWidth="icon"
          className="cursor-pointer appearance-none bg-zinc-900 text-transparent hover:bg-zinc-800"
        >
          <option value="" disabled className="text-zinc-100">Add scene</option>
          {available.map((template) => <option className="text-zinc-100" key={template.id} value={template.id}>{template.title}</option>)}
        </UiSelect>
      </Tip>
    </div>
  );
}

function basename(path: string) {
  return path.split("/").pop() || path;
}

function fallbackItemTitle(path: string) {
  const file = basename(path);
  const stem = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) : file;
  return stem.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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
    for (const view of template.views) if (!paths.includes(view.file)) paths.push(view.file);
    items[id] = paths;
  }
  return { version: 1, order, titles, items };
}

function itemTitle(sceneId: string, path: string, templates: TemplateManifest[]) {
  return (
    templates
      .find((template) => template.id === sceneId)
      ?.views.find((view) => view.file === path)?.title ?? fallbackItemTitle(path)
  );
}

function rendererFor(
  path: string,
  content: string | undefined,
  ctx: WorkbenchContext
): RendererDesc | undefined {
  const bound = ctx.bindings[path] ? getRenderer(ctx.bindings[path], ctx.plugins) : undefined;
  if (bound) return bound;
  if (content === undefined) return undefined;
  return candidatesFor(path, content, ctx.plugins)[0];
}

async function readDiscoverableFiles(
  entries: FsEntry[],
  ctx: WorkbenchContext,
  onBatch: (values: Record<string, string>) => void
) {
  const candidates = entries.filter((entry) => {
    if (entry.is_dir || entry.path === ".workbench.json") return false;
    if (ctx.bindings[entry.path] && getRenderer(ctx.bindings[entry.path], ctx.plugins)) return false;
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

export function SceneWorkbench({
  ctx,
  sceneState,
  legacyEnvironment,
  templates,
  onAddScene,
}: {
  ctx: WorkbenchContext;
  sceneState?: WorkbenchSceneState;
  legacyEnvironment?: string | null;
  templates: TemplateManifest[];
  onAddScene: (manifest: TemplateManifest) => Promise<boolean>;
}) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const reconciled = useMemo(
    () => reconcileSceneItems(sceneState, templates, legacyEnvironment),
    [sceneState, templates, legacyEnvironment]
  );
  const storagePrefix = `cheers.workbench.${ctx.channelId}`;
  const [activeScene, setActiveScene] = useState(
    () => localStorage.getItem(`${storagePrefix}.scene`) || reconciled.order[0] || ""
  );
  const [selectedByScene, setSelectedByScene] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const listing = await ctx.fs.ls("");
      setEntries(listing.entries);
      setStatus(null);
      void readDiscoverableFiles(listing.entries, ctx, (values) =>
        setContents((previous) => ({ ...previous, ...values }))
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn’t load Workbench items");
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    if (ctx.filesTick !== undefined) void refresh();
  }, [ctx.filesTick, refresh]);

  const existing = useMemo(
    () => new Set(entries.filter((entry) => !entry.is_dir).map((entry) => entry.path)),
    [entries]
  );
  const renderers = useMemo(() => {
    const found: Record<string, RendererDesc> = {};
    for (const path of existing) {
      const renderer = rendererFor(path, contents[path], ctx);
      if (renderer) found[path] = renderer;
    }
    return found;
  }, [existing, contents, ctx]);
  const claimed = useMemo(
    () => new Set(reconciled.order.flatMap((id) => reconciled.items[id] ?? [])),
    [reconciled]
  );
  const otherPaths = useMemo(
    () => Object.keys(renderers).filter((path) => !claimed.has(path)).sort((a, b) => a.localeCompare(b)),
    [renderers, claimed]
  );
  const sceneIds = useMemo(
    () => [...reconciled.order, ...(otherPaths.length ? [OTHER_SCENE] : [])],
    [reconciled.order, otherPaths.length]
  );

  useEffect(() => {
    if (!sceneIds.length) {
      setActiveScene("");
      return;
    }
    if (!sceneIds.includes(activeScene)) setActiveScene(sceneIds[0]);
  }, [sceneIds, activeScene]);
  useEffect(() => {
    if (!activeScene) return;
    localStorage.setItem(`${storagePrefix}.scene`, activeScene);
  }, [activeScene, storagePrefix]);

  const activePaths = useMemo(() => {
    const paths = activeScene === OTHER_SCENE ? otherPaths : reconciled.items[activeScene] ?? [];
    return paths.filter((path) => existing.has(path) && renderers[path]);
  }, [activeScene, otherPaths, reconciled.items, existing, renderers]);
  const storedSelection = activeScene
    ? localStorage.getItem(`${storagePrefix}.item.${activeScene}`)
    : null;
  const selectedPath =
    (selectedByScene[activeScene] && activePaths.includes(selectedByScene[activeScene])
      ? selectedByScene[activeScene]
      : storedSelection && activePaths.includes(storedSelection)
        ? storedSelection
        : activePaths[0]) ?? null;

  const selectPath = (path: string) => {
    setSelectedByScene((previous) => ({ ...previous, [activeScene]: path }));
    localStorage.setItem(`${storagePrefix}.item.${activeScene}`, path);
  };

  useEffect(() => {
    const target = ctx.openTarget;
    if (!target || !renderers[target]) return;
    const owner = reconciled.order.find((id) => (reconciled.items[id] ?? []).includes(target));
    setActiveScene(owner ?? OTHER_SCENE);
    setSelectedByScene((previous) => ({ ...previous, [owner ?? OTHER_SCENE]: target }));
  }, [ctx.openTarget, renderers, reconciled]);

  const available = templates.filter((template) => !reconciled.order.includes(template.id));
  const title =
    activeScene === OTHER_SCENE
      ? "Other"
      : reconciled.titles[activeScene] ?? templates.find((template) => template.id === activeScene)?.title ?? activeScene;

  if (loading && entries.length === 0) {
    return <div className="flex h-full items-center justify-center text-compact text-zinc-400">Preparing Workbench…</div>;
  }

  if (sceneIds.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <LayoutGrid className="h-5 w-5 text-zinc-400" />
        <div>
          <div className="text-regular font-medium text-zinc-200">Choose a scene</div>
          <p className="mt-1 max-w-sm text-compact leading-5 text-zinc-400">
            Scenes turn workspace data into focused tabs. Unsupported files remain available in Raw.
          </p>
        </div>
        {available.length > 0 && (
          <UiSelect
            defaultValue=""
            onChange={(event) => {
              const manifest = templates.find((candidate) => candidate.id === event.target.value);
              if (manifest) void onAddScene(manifest);
              event.currentTarget.value = "";
            }}
            controlSize="regular" className="rounded-sm bg-indigo-600 text-compact font-medium text-white outline-none"
          >
            <option value="" disabled>Add a scene…</option>
            {available.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
          </UiSelect>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950/30">
      <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-zinc-800/80 px-2 py-2 md:hidden">
        {sceneIds.map((id) => {
          const meta = metaFor(id);
          const Icon = meta.Icon;
          return (
            <UiButton content="iconText" variant="plain" role="tab" aria-selected={activeScene === id}
              key={id}
              type="button"
              onClick={() => setActiveScene(id)}
              controlSize="regular" className={cn(
 "flex flex-shrink-0 items-center gap-2 rounded-sm  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
 activeScene === id ? "bg-indigo-500/15 text-indigo-200": "text-zinc-100 hover:bg-zinc-800/60 hover:text-zinc-50"
 )}
            >
              <Icon className="h-4 w-4" />
              {id === OTHER_SCENE ? "Other" : reconciled.titles[id] ?? id}
            </UiButton>
          );
        })}
        <AddSceneControl available={available} onSelect={(manifest) => void onAddScene(manifest)} />
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-36 flex-shrink-0 flex-col border-r border-zinc-800/80 p-2 md:flex">
          <div className="px-2 pb-2 pt-1 text-minimal font-medium uppercase tracking-[0.12em] text-zinc-400">Scenes</div>
          <div className="space-y-1">
            {sceneIds.map((id) => {
              const meta = metaFor(id);
              const Icon = meta.Icon;
              const selected = activeScene === id;
              return (
                <UiButton controlWidth="fill" variant="plain" role="tab" aria-selected={selected}
                  key={id}
                  type="button"
                  onClick={() => setActiveScene(id)}
                  aria-pressed={selected}
                  controlSize="comfortable" className={cn(
 "flex items-center gap-2 rounded-sm text-left  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
 selected ? "bg-indigo-500/15 text-indigo-200": "text-zinc-100 hover:bg-zinc-800/60 hover:text-zinc-50"
 )}
                >
                  <Icon className={cn("h-4 w-4 flex-shrink-0", selected && meta.color)} />
                  <span className="min-w-0 truncate">{id === OTHER_SCENE ? "Other" : reconciled.titles[id] ?? id}</span>
                </UiButton>
              );
            })}
          </div>
          <div className="mt-auto pt-2">
            <AddSceneControl available={available} onSelect={(manifest) => void onAddScene(manifest)} />
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {activePaths.length > 0 && (
            <nav aria-label={`${title} items`} className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-zinc-800/80 px-2">
              {activePaths.map((path) => {
                const selected = path === selectedPath;
                return (
                  <UiButton variant="plain" role="tab" aria-selected={selected}
                    key={path}
                    type="button"
                    onClick={() => selectPath(path)}
                    aria-current={selected ? "page" : undefined}
                    controlSize="comfortable" className={cn(
 "relative flex-shrink-0  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500",
 selected ? "text-indigo-300": "text-zinc-100 hover:text-zinc-50"
 )}
                  >
                    {itemTitle(activeScene, path, templates)}
                    {selected && <span data-design-system-exempt="progress" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-indigo-500" />}
                  </UiButton>
                );
              })}
            </nav>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            {selectedPath && renderers[selectedPath] ? (
              <RendererHost
                ctx={ctx}
                path={selectedPath}
                renderer={renderers[selectedPath]}
                config={ctx.configs[selectedPath]}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-compact text-zinc-400">
                <FileQuestion className="h-5 w-5 text-zinc-400" />
                <span>No native items in this scene.</span>
                <span className="max-w-xs text-compact leading-4 text-zinc-400">Unsupported files stay hidden here and remain available from Raw.</span>
              </div>
            )}
          </div>
          {status && <div className="border-t border-zinc-800 px-3 py-2 text-compact text-amber-300">{status}</div>}
        </section>
      </div>
    </div>
  );
}
