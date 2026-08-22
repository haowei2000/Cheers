import { ContextActionsProvider } from "@/components/ui/context-actions";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { createRoot, type Root } from "react-dom/client";
import { Folder, LayoutGrid } from "lucide-react";
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

const installedTemplates = templates;
const sceneState: WorkbenchSceneState = {
  version: 1,
  order: installedTemplates.map((template) => template.id),
  titles: Object.fromEntries(installedTemplates.map((template) => [template.id, template.title])),
  items: Object.fromEntries(installedTemplates.map((template) => [template.id, template.views.map((view) => view.file)])),
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
    <ContextActionsProvider>
      <main className="relative h-full overflow-hidden bg-zinc-950 text-content-primary">
        <FloatingPanel
          title="Workbench"
          icon={LayoutGrid}
          onClose={() => undefined}
          storageKey="cheers.preview.adaptive-workbench"
          className="h-[min(720px,calc(100%-4rem))] w-[min(1040px,calc(100%-4rem))]"
          defaultPosClassName="left-1/2 top-8 -translate-x-1/2"
          bodyClassName="flex flex-col overflow-hidden p-0 space-y-0 md:pt-[var(--floating-panel-safe-top)]"
          panelActions={[{
            id: "raw-mode",
            label: "Show raw workspace files",
            priority: "primary",
            icon: Folder,
            onSelect: () => undefined,
          }]}
        >
          <SceneWorkbench
            ctx={context}
            sceneState={sceneState}
            templates={templates}
            onAddScene={async () => true}
            onShowRaw={() => undefined}
          />
        </FloatingPanel>
      </main>
    </ContextActionsProvider>
  );
}

const previewGlobal = globalThis as typeof globalThis & { __sceneWorkbenchPreviewRoot?: Root };
const previewRoot = previewGlobal.__sceneWorkbenchPreviewRoot ?? createRoot(document.getElementById("root")!);
previewGlobal.__sceneWorkbenchPreviewRoot = previewRoot;
previewRoot.render(<Preview />);
