import { Button as UiButton } from "@/components/ui/button";
import { createRoot, type Root } from "react-dom/client";
import { Folder, LayoutGrid, Maximize2, X } from "lucide-react";
import "@/index.css";
import { SceneWorkbench } from "./SceneWorkbench";
import type { WorkbenchContext } from "./context";
import type { TemplateManifest } from "./manifest";
import type { WorkbenchSceneState } from "./WorkbenchDrawer";
import "./lens/builtins";

const files: Record<string, string> = {
  "dev/plan.yaml": "columns:\n  - name: Planned\n    items: [Implement native Web scenes]\n  - name: In progress\n    items: [Build Codemap renderer]\n  - name: Shipped\n    items: []\n",
  "dev/issues.yaml": "- title: Raw files visible by default\n  severity: P1\n  status: fixed\n",
  "dev/progress.yaml": "series:\n  - name: tests passing\n    points: [[1, 88], [2, 104], [3, 121]]\n",
  "dev/todo.md": "# Todo\n\n- [x] Scene navigation\n- [x] Native Codemap\n- [ ] Visual QA\n",
  "codemap/map.yaml": `codemap: 1
repo: haowei2000/Cheers
updated: 2026-08-04T11:45:00Z
focus: [gateway.fs]
edges:
  - { from: ios.workbench, to: gateway.fs, kind: calls, label: fs.patch }
  - { from: web.workbench, to: gateway.fs, kind: calls, label: fs.patch }
  - { from: gateway.fs, to: shared.scene_state, kind: data, label: writes }
  - { from: shared.scene_state, to: shared.renderer_registry, kind: data }
nodes:
  ios.workbench:
    kind: module
    label: iOS Workbench
    summary: Native SwiftUI scenes and structured editors.
    status: explored
    tags: [ios, swiftui]
  web.workbench:
    kind: module
    label: Web Workbench
    summary: Content-first scene navigation and native renderers inside the existing channel drawer.
    status: explored
    tags: [web, react]
  gateway.fs:
    kind: module
    label: Gateway fs.patch
    loc: cheers:ws/@gateway/server/src/resource/fs.rs#L564
    summary: Applies atomic structured file updates with optimistic version checks.
    status: explored
    tags: [gateway, fs, patch]
  shared.scene_state:
    kind: module
    label: Scene state
    summary: Stores shared scene order, titles, and content item paths.
    status: partial
    tags: [workbench, navigation]
  shared.renderer_registry:
    kind: module
    label: Renderer registry
    summary: Resolves native and extension renderers from bindings and content.
    status: stale
    tags: [renderer]
`,
};

const entries = Object.entries(files).map(([path, content], index) => ({
  path,
  version: index + 1,
  is_dir: false,
  size_bytes: content.length,
}));

const templates: TemplateManifest[] = [{
  id: "cheers-code-project",
  title: "Code project",
  views: [
    { id: "plan", title: "Plan", file: "dev/plan.yaml", lens: "kanban" },
    { id: "issues", title: "Issues", file: "dev/issues.yaml", lens: "table" },
    { id: "progress", title: "Progress", file: "dev/progress.yaml", lens: "chart" },
    { id: "todo", title: "Todo", file: "dev/todo.md", lens: "markdown" },
    { id: "codemap", title: "Codemap", file: "codemap/map.yaml", lens: "codemap" },
  ],
}, {
  id: "cheers-research-lab",
  title: "Research lab",
  views: [],
}, {
  id: "cheers-task-board",
  title: "Tasks",
  views: [],
}, {
  id: "cheers-team-ops",
  title: "Operations",
  views: [],
}];

const sceneState: WorkbenchSceneState = {
  version: 1,
  order: templates.map((template) => template.id),
  titles: Object.fromEntries(templates.map((template) => [template.id, template.title])),
  items: Object.fromEntries(templates.map((template) => [template.id, template.views.map((view) => view.file)])),
};

localStorage.setItem("cheers.workbench.preview.scene", "cheers-code-project");
localStorage.setItem("cheers.workbench.preview.item.cheers-code-project", "codemap/map.yaml");

const context: WorkbenchContext = {
  active: true,
  channelId: "preview",
  fs: {
    ls: async () => ({ path: "", entries }),
    read: async (path) => ({ path, content: files[path] ?? "", version: 1, is_dir: false }),
    write: async (path) => ({ path, version: 2 }),
    rm: async () => undefined,
  },
  sendResourceReq: async () => ({}),
  pinned: [],
  togglePin: () => undefined,
  rendererExtensions: [],
  bindings: {
    "dev/plan.yaml": "builtin:kanban",
    "dev/issues.yaml": "builtin:table",
    "dev/progress.yaml": "builtin:chart",
    "dev/todo.md": "builtin:markdown",
    "codemap/map.yaml": "builtin:codemap",
  },
  setBinding: () => undefined,
  configs: {},
};

function Preview() {
  return (
    <main className="flex h-full items-center justify-center bg-zinc-950 p-5 text-content-primary">
      <section className="flex h-full w-full max-w-[1120px] flex-col overflow-hidden rounded-sm bg-zinc-900 shadow-2xl shadow-black/50">
        <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
          <LayoutGrid className="h-4 w-4 text-accent-300" />
          <h1 className="text-regular font-semibold">Workbench</h1>
          <span className="text-compact text-content-muted"># engineering</span>
          <div className="ml-auto flex items-center gap-2">
            <UiButton content="iconText" variant="plain" controlSize="regular" className="bg-zinc-800 text-content-primary"><Folder className="h-4 w-4" />Raw</UiButton>
            <UiButton variant="plain" aria-label="Expand" content="icon" controlSize="regular" className="flex items-center justify-center rounded-sm text-content-primary hover:bg-zinc-800"><Maximize2 className="h-4 w-4" /></UiButton>
            <UiButton variant="plain" aria-label="Close" content="icon" controlSize="regular" className="flex items-center justify-center rounded-sm text-content-primary hover:bg-zinc-800"><X className="h-4 w-4" /></UiButton>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <SceneWorkbench
            ctx={context}
            sceneState={sceneState}
            templates={templates}
            onAddScene={async () => true}
          />
        </div>
      </section>
    </main>
  );
}

const previewGlobal = globalThis as typeof globalThis & { __sceneWorkbenchPreviewRoot?: Root };
const previewRoot = previewGlobal.__sceneWorkbenchPreviewRoot ?? createRoot(document.getElementById("root")!);
previewGlobal.__sceneWorkbenchPreviewRoot = previewRoot;
previewRoot.render(<Preview />);
