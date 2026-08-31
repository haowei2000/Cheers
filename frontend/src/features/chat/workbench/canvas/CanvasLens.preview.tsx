import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { ContextActionsProvider } from "@/components/ui/context-actions";
import { CanvasLens } from "./CanvasLens";
import { applyPatchOps, type PatchOp } from "../patchOps";
import "@/index.css";

// Harness for the canvas, with no gateway: `onOps` applies the ops to local state the
// way `useFile.applyOps` applies them to the file, and every batch is echoed on screen.
//
// Run it: `npm run dev`, then open /dev/canvas.html.
//
// What it exists to show, none of which a pure test can reach:
//   1. Unpinned nodes are arranged; the pinned one stays where the file put it.
//   2. Dragging the background pans; dragging a node moves only that node.
//   3. A drop emits ONE `set ["nodes", i, "rect"]` — dragging is what pins.
//   4. Dragging a port to another node emits an `insert ["edges"]`, and the connector
//      stays attached to the right sides afterwards.
//   5. Undo walks back, one gesture at a time.
//   6. A click (travel under the slop threshold) selects rather than pinning.

const START = {
  canvas: 1,
  layout: "dag",
  nodes: [
    { id: "brief", text: "# Brief\nWhat the channel is trying to ship." },
    { id: "plan", source: { kind: "fs", path: "dev/plan.yaml" }, view: "builtin:kanban" },
    { id: "issues", source: { kind: "fs", path: "dev/issues.yaml" }, view: "builtin:table" },
    { id: "roster", source: { kind: "resource", verb: "channel.members", pick: "members" }, view: "builtin:table" },
    { id: "pinned", text: "# Pinned\nThis one carries a rect, so layout leaves it alone.", rect: { x: 700, y: 40, w: 260, h: 160 } },
  ],
  edges: [{ id: "brief-plan", from: { node: "brief", side: "right" }, to: { node: "plan", side: "left" }, label: "drives" }],
};

function Preview() {
  const [doc, setDoc] = useState<unknown>(START);
  const [log, setLog] = useState<string[]>([]);

  const onOps = (ops: readonly PatchOp[]) => {
    setDoc((current: unknown) => applyPatchOps(current, ops));
    setLog((entries) => [ops.map((op) => `${op.op} ${JSON.stringify(op.path)}`).join("  ·  "), ...entries].slice(0, 8));
  };

  return (
    <ContextActionsProvider>
      <main className="group/floating-panel h-screen w-screen bg-canvas p-4 text-content-primary">
        <div className="mb-3 flex items-baseline gap-3">
          <span className="text-compact text-content-secondary">
            Drag the background to pan · drag a node to pin it · select a node, then drag a handle to connect · Cmd/Ctrl+Z to undo
          </span>
        </div>
        <section className="relative h-[calc(100%-7rem)] w-full overflow-hidden rounded-sm ring-1 ring-line-subtle">
          <CanvasLens data={doc} config={undefined} onChange={() => undefined} onOps={onOps} />
        </section>
        <div className="mt-2 h-20 overflow-y-auto font-code text-minimal text-content-muted">
          {log.length === 0 ? <div>no ops yet</div> : log.map((entry, index) => <div key={index}>{entry}</div>)}
        </div>
      </main>
    </ContextActionsProvider>
  );
}

const previewGlobal = globalThis as typeof globalThis & { __canvasPreviewRoot?: Root };
const previewRoot = previewGlobal.__canvasPreviewRoot ?? createRoot(document.getElementById("root")!);
previewGlobal.__canvasPreviewRoot = previewRoot;
previewRoot.render(<Preview />);
