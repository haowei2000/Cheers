import { ContextActionsProvider } from "@/components/ui/context-actions";
import { ResourceError } from "@/features/chat/hooks/useChatRealtime";
import { ThemeProvider } from "@/components/ui/theme";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { FolderTree } from "lucide-react";
import { createRoot, type Root } from "react-dom/client";
import { FilePanel } from "./FilePanel";
import type { WorkbenchContext } from "../context";
import { applyPatchOps, type PatchOp } from "../patchOps";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import "../lens/builtins";
import "@/index.css";

// Harness for one file's TWO views, with no gateway. The fs here is STATEFUL — real
// content, real versions, a real optimistic lock — because every defect this exists to
// show is about the two views disagreeing about those three things.
//
// Walk it:
//  1. Pick dev/plan.yaml (previews as a kanban). Switch to Raw, add a column, DON'T save,
//     switch back to Preview — the new column is there. (It used to be invisible: Raw and
//     Preview each ran their own fs.read.)
//  2. Still unsaved, the dirty dot ● shows in BOTH modes and one Save serves both.
//  3. In Raw, break the YAML (type `  [` on a new line). The preview keeps the last
//     version that parsed, the header says "syntax error", and the kanban's edit controls
//     are GONE — writing from a stale document would overwrite what you are typing.
//  4. Fix it; the controls come back.
//  5. Edit in Preview, Save, switch to Raw — the text is the serialized edit and Save is
//     disabled. (It used to conflict: Raw's version was stale.)
//  6. Set dev/plan.yaml to Raw, click another file, click back — still Raw. (Mode used to
//     reset to Preview on every selection change.)
//  7. dev/notes.md has NO structured renderer: Preview is disabled, Raw only.

const initial: Record<string, string> = {
  "dev/plan.yaml": `# The board the channel works from. Comments here must survive every edit.
columns:
  - name: Planned
    items: [Unify the file session]
  - name: In progress
    items: [Raw/Preview switching]
  - name: Shipped
    items: []
`,
  "dev/issues.yaml": `# One row per issue.
- title: Unsaved Raw edits vanished on switch
  severity: P1
  status: fixed
- title: Renderer matched against the wrong buffer
  severity: P1
  status: fixed
`,
  "dev/notes.md": "# Notes\n\nPlain markdown — previews, but as text.\n",
  "canvases/architecture.canvas.yaml": `canvas: 1
layout: dag
nodes:
  - id: raw
    text: "# Raw\\nEdits text."
  - id: preview
    text: "# Preview\\nRenders data parsed from that text."
edges:
  - { id: raw-preview, from: { node: raw, side: right }, to: { node: preview, side: left }, label: one buffer }
`,
};

const files = new Map(Object.entries(initial));
const versions = new Map([...files.keys()].map((path) => [path, 1]));

// Real ResourceErrors, not look-alikes: the session branches on `instanceof
// ResourceError`, so a harness that throws a plain Error would never exercise the
// NOT_FOUND create path or the conflict replay — the two paths most worth seeing.
const conflict = () => new ResourceError("VERSION_CONFLICT", "version conflict");
const notFound = () => new ResourceError("NOT_FOUND", "not found");

const context: WorkbenchContext = {
  active: true,
  channelId: "preview",
  fs: {
    ls: async () => ({
      path: "",
      entries: [...files].map(([path, content]) => ({
        path,
        version: versions.get(path) ?? 1,
        is_dir: false,
        size_bytes: content.length,
      })),
    }),
    read: async (path) => {
      // A missing file is NOT_FOUND, as the gateway answers — the session distinguishes
      // "does not exist yet" (write with if_version 0 creates it) from "exists and is
      // empty", and a harness that always answers with a version hides the difference.
      const content = files.get(path);
      if (content === undefined) throw notFound();
      return { path, content, version: versions.get(path) ?? 1, is_dir: false };
    },
    write: async (path, content, ifVersion) => {
      const current = versions.get(path) ?? 0;
      if (ifVersion !== undefined && ifVersion !== current) throw conflict();
      files.set(path, content);
      versions.set(path, current + 1);
      return { path, version: current + 1 };
    },
    // Applies the ops for real, so the canvas's write-through path is exercised end to
    // end. (Comment preservation is the gateway's job — this re-serializes.)
    patch: async (path: string, ops: readonly PatchOp[], ifVersion: number) => {
      const current = versions.get(path) ?? 0;
      if (ifVersion !== current) throw conflict();
      const next = applyPatchOps(yamlParse(files.get(path) ?? ""), ops);
      files.set(path, yamlStringify(next));
      versions.set(path, current + 1);
      return { path, version: current + 1 };
    },
    rm: async () => undefined,
  },
  sendResourceReq: async () => ({}),
  pinned: [],
  togglePin: () => undefined,
  rendererExtensions: [],
  // table/kanban are `pickable: false` — they need config, so a template's `view` binds
  // them rather than the generic picker offering them. Same as a real channel.
  bindings: {
    "dev/plan.yaml": "builtin:kanban",
    "dev/issues.yaml": "builtin:table",
  },
  setBinding: () => undefined,
  configs: {},
};

function Preview() {
  return (
    <ThemeProvider>
      <ContextActionsProvider>
        {/* Inside a FloatingPanel, because that is where FilePanel actually runs — and
            its eye, Save and notes buttons now live in the panel's action corner, so a
            harness without one would show none of them. */}
        <main className="relative h-screen w-screen overflow-hidden bg-canvas text-content-primary">
          <FloatingPanel
            title="Files"
            icon={FolderTree}
            onClose={() => undefined}
            storageKey="cheers.preview.file-panel"
            className="h-[min(760px,calc(100%-4rem))] w-[min(1100px,calc(100%-4rem))]"
            defaultPosClassName="left-1/2 top-8 -translate-x-1/2"
            bodyClassName="flex flex-col overflow-hidden p-0 space-y-0"
          >
            <FilePanel ctx={context} />
          </FloatingPanel>
        </main>
      </ContextActionsProvider>
    </ThemeProvider>
  );
}

const previewGlobal = globalThis as typeof globalThis & { __filePanelPreviewRoot?: Root };
const previewRoot = previewGlobal.__filePanelPreviewRoot ?? createRoot(document.getElementById("root")!);
previewGlobal.__filePanelPreviewRoot = previewRoot;
previewRoot.render(<Preview />);
