import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Boxes, Database, ExternalLink, FileText, Link2, Maximize2, Minus, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { Button as UiButton } from "@/components/ui/button";
import { FLOATING_CHROME_CONTROL_SIZE } from "@/components/ui/control-size";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import type { LensProps } from "../lens/registry";
import { applyPatchOps, invertPatchOps, type PatchOp } from "../patchOps";
import { canvasLayout } from "./layout";
import { connectOps, pinNodeOps, removeNodeOps } from "./ops";
import { nodeTitle, parseCanvas, type CanvasNode, type CanvasRect, type CanvasSide } from "./document";
import {
  activateCanvasNode,
  canvasNodeKeyAction,
  fitCanvasTransform,
  moveCanvasRectWithKeyboard,
  nextCanvasNodeId,
  removeCanvasNodeState,
} from "./viewTransform";

// The canvas view: nodes an agent wrote, arranged by a human, both writing the same file.
//
// Every gesture becomes a structured `fs.patch` op rather than a whole-document save
// (see patchOps.ts) — which is what lets a person drag a node while an agent edits a
// different one, and what keeps the comments in a file that both of them read.
//
// Pointer arbitration is the part that is easy to get wrong, so it is stated in ONE
// place (`onPointerDown` below) rather than spread across handlers: the deepest thing
// under the cursor wins, and the background is the fallback. The movement threshold is
// borrowed from CodemapLens for the same reason it exists there — without it, every
// drag also fires the click that clears the selection.

const DRAG_SLOP_PX = 4;
const SIDES: readonly CanvasSide[] = ["top", "right", "bottom", "left"];
const MIN_SCALE = 0.4;
const MAX_SCALE = 2.2;
const CONTENT_PAD = 80;

type Gesture =
  | { kind: "pan"; pointer: number; x: number; y: number; ox: number; oy: number }
  | { kind: "node"; pointer: number; id: string; grabX: number; grabY: number; rect: CanvasRect }
  | { kind: "connect"; pointer: number; from: string; side: CanvasSide };

function anchorOf(rect: CanvasRect, side: CanvasSide): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: rect.x + rect.w / 2, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    case "left":
      return { x: rect.x, y: rect.y + rect.h / 2 };
    case "right":
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
  }
}

/** The side of `a` that faces `b` — used when an edge names no side of its own, so a
 *  connector always leaves from the edge pointing at its target rather than a fixed
 *  corner. */
function facing(a: CanvasRect, b: CanvasRect): CanvasSide {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** A cubic whose control points leave along the anchor's own axis, so a connector
 *  departs perpendicular to the node's edge instead of cutting across it. */
function curve(from: { x: number; y: number }, fromSide: CanvasSide, to: { x: number; y: number }, toSide: CanvasSide): string {
  const reach = Math.max(40, Math.hypot(to.x - from.x, to.y - from.y) / 3);
  const out = offsetFor(fromSide, reach);
  const into = offsetFor(toSide, reach);
  return `M ${from.x} ${from.y} C ${from.x + out.x} ${from.y + out.y}, ${to.x + into.x} ${to.y + into.y}, ${to.x} ${to.y}`;
}

function offsetFor(side: CanvasSide, reach: number): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: 0, y: -reach };
    case "bottom":
      return { x: 0, y: reach };
    case "left":
      return { x: -reach, y: 0 };
    case "right":
      return { x: reach, y: 0 };
  }
}

function NodeBody({ node }: { node: CanvasNode }) {
  if (node.kind === "text") {
    return (
      <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3 text-compact text-content-secondary">
        <MarkdownRenderer content={node.text} />
      </div>
    );
  }
  // A source node is a CARD, not a live render. Mounting a lens per node would nest a
  // third interactive layer inside the drag and the pan; docs/arch/CANVAS.md keeps that
  // for last, and until then the card says what it points at and opens it on click.
  const detail = node.source.kind === "fs" ? node.source.path : node.source.verb;
  return (
    <div className="flex min-h-0 flex-1 items-start gap-2 px-3 pb-3">
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-sm bg-control text-content-secondary">
        {node.source.kind === "fs" ? <FileText className="h-4 w-4" /> : <Database className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-compact text-content-secondary" title={detail}>{detail}</span>
        {node.view && <span className="mt-1 block truncate text-minimal text-content-muted">{node.view}</span>}
      </span>
    </div>
  );
}

export function CanvasLens({ data, onOps, requestContextPick, openLocator }: LensProps) {
  const document_ = useMemo(() => parseCanvas(data), [data]);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 24, y: 24 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [connectingFromId, setConnectingFromId] = useState<string | null>(null);
  /** The node under an active drag, so it follows the cursor without a write per frame. */
  const [dragging, setDragging] = useState<{ id: string; rect: CanvasRect } | null>(null);
  /** The connector being pulled, in canvas coordinates. */
  const [wire, setWire] = useState<{ from: string; side: CanvasSide; x: number; y: number } | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const undoStack = useRef<PatchOp[][]>([]);
  const expected = useRef<string | null>(null);
  const known = useRef<string | null>(null);

  const placed = useMemo(
    () => canvasLayout(document_?.nodes ?? [], document_?.edges ?? [], document_?.layout ?? "dag"),
    [document_]
  );
  const rectOf = useCallback(
    (id: string): CanvasRect | undefined => (dragging?.id === id ? dragging.rect : placed.get(id)),
    [dragging, placed]
  );

  // An undo entry is only replayable against the document it was computed from. When
  // the file changes underneath — an agent writing, a teammate saving — replaying one
  // would edit whatever now sits at that index. So the stack is dropped rather than
  // allowed to corrupt the document it was meant to protect.
  useEffect(() => {
    const now = JSON.stringify(data);
    if (known.current !== null && now !== known.current && expected.current !== now) {
      undoStack.current = [];
    }
    if (expected.current === now) expected.current = null;
    known.current = now;
  }, [data]);

  const emit = useCallback(
    (ops: PatchOp[], { undoable = true } = {}) => {
      if (!onOps || ops.length === 0) return;
      try {
        if (undoable) undoStack.current.push(invertPatchOps(data, ops));
        expected.current = JSON.stringify(applyPatchOps(data, ops));
      } catch {
        undoStack.current = [];
        expected.current = null;
      }
      onOps(ops);
    },
    [data, onOps]
  );

  const undo = useCallback(() => {
    const ops = undoStack.current.pop();
    // The inverse is applied as a plain edit: pushing ITS inverse would turn the stack
    // into a redo of the thing just undone.
    if (ops) emit(ops, { undoable: false });
  }, [emit]);

  /** Client coordinates → canvas coordinates, through the current pan and zoom. */
  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const box = viewportRef.current?.getBoundingClientRect();
      if (!box) return { x: 0, y: 0 };
      return { x: (clientX - box.left - offset.x) / scale, y: (clientY - box.top - offset.y) / scale };
    },
    [offset, scale]
  );

  /** What is under the cursor right now.
   *
   *  `event.target` cannot answer this during a gesture: `setPointerCapture` retargets
   *  every subsequent pointer event to the element that captured it, so a drop would
   *  always report the viewport and never the node it landed on. */
  const nodeAtPoint = (clientX: number, clientY: number): string | undefined =>
    globalThis.document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-canvas-node]")?.dataset.canvasNode;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Controls keep their own click — the same guard CodemapLens uses.
    if (target.closest("button")) return;
    moved.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);

    const port = target.closest<HTMLElement>("[data-canvas-port]");
    if (port?.dataset.canvasPort && port.dataset.canvasSide) {
      gesture.current = {
        kind: "connect",
        pointer: event.pointerId,
        from: port.dataset.canvasPort,
        side: port.dataset.canvasSide as CanvasSide,
      };
      const at = toCanvas(event.clientX, event.clientY);
      setWire({ from: port.dataset.canvasPort, side: port.dataset.canvasSide as CanvasSide, ...at });
      return;
    }

    const card = target.closest<HTMLElement>("[data-canvas-node]");
    const id = card?.dataset.canvasNode;
    if (id) {
      const rect = rectOf(id);
      if (rect) {
        const at = toCanvas(event.clientX, event.clientY);
        gesture.current = { kind: "node", pointer: event.pointerId, id, grabX: at.x - rect.x, grabY: at.y - rect.y, rect };
      }
      return;
    }

    gesture.current = { kind: "pan", pointer: event.pointerId, x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    if (active.kind === "pan") {
      const dx = event.clientX - active.x;
      const dy = event.clientY - active.y;
      if (Math.abs(dx) > DRAG_SLOP_PX || Math.abs(dy) > DRAG_SLOP_PX) moved.current = true;
      setOffset({ x: active.ox + dx, y: active.oy + dy });
      return;
    }
    const at = toCanvas(event.clientX, event.clientY);
    if (active.kind === "node") {
      const next = { ...active.rect, x: at.x - active.grabX, y: at.y - active.grabY };
      if (Math.abs(next.x - active.rect.x) > DRAG_SLOP_PX || Math.abs(next.y - active.rect.y) > DRAG_SLOP_PX) {
        moved.current = true;
      }
      setDragging({ id: active.id, rect: next });
      return;
    }
    moved.current = true;
    setWire({ from: active.from, side: active.side, ...at });
  };

  const activateNode = useCallback(
    (targetId: string) => {
      if (!document_) return;
      const activation = activateCanvasNode(selectedId, connectingFromId, targetId);
      if (activation.connection) {
        emit(connectOps(
          document_,
          { node: activation.connection.from },
          { node: activation.connection.to }
        ));
      }
      setConnectingFromId(activation.connectingFromId);
      setSelectedId(activation.selectedId);
    },
    [connectingFromId, document_, emit, selectedId]
  );

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    gesture.current = null;
    if (!active || active.pointer !== event.pointerId) return;

    if (active.kind === "node") {
      const node = document_?.nodes.find((candidate) => candidate.id === active.id);
      // Below the threshold this was a click, not a drag: select rather than pin, so a
      // stray pixel of movement does not silently rewrite the file.
      if (!moved.current || !dragging || !node) {
        setDragging(null);
        if (!moved.current) activateNode(active.id);
        return;
      }
      emit(pinNodeOps(node, dragging.rect));
      setDragging(null);
      return;
    }

    if (active.kind === "connect") {
      const dropped = nodeAtPoint(event.clientX, event.clientY);
      setWire(null);
      if (dropped && document_) {
        const target = rectOf(dropped);
        const source = rectOf(active.from);
        const toSide = target && source ? facing(target, source) : undefined;
        emit(connectOps(document_, { node: active.from, side: active.side }, { node: dropped, side: toSide }));
      }
      return;
    }

    // A pan that never moved is a click on the background: clear the selection.
    if (!moved.current) setSelectedId(null);
  };

  const zoom = (factor: number) =>
    setScale((current) => Math.min(MAX_SCALE, Math.max(Math.min(MIN_SCALE, current), current * factor)));

  const openSource = useCallback(
    (node: CanvasNode) => {
      if (!openLocator || node.kind !== "source") return;
      const uri =
        node.source.kind === "fs"
          ? `cheers:desk/${node.source.path}`
          : `cheers:${node.source.verb.replace(/^channel\./, "").replace(/\.read$/, "")}`;
      openLocator(uri);
    },
    [openLocator]
  );

  const removeSelected = useCallback(() => {
    if (!selectedId || !document_) return;
    const next = removeCanvasNodeState(selectedId, connectingFromId, selectedId);
    emit(removeNodeOps(document_, selectedId));
    setSelectedId(next.selectedId);
    setConnectingFromId(next.connectingFromId);
  }, [connectingFromId, document_, emit, selectedId]);

  const onNodeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, node: CanvasNode) => {
      const action = canvasNodeKeyAction(event.key, {
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        writable: !!onOps,
      });
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action.kind === "activate") {
        activateNode(node.id);
        return;
      }
      if (action.kind === "remove") {
        const next = removeCanvasNodeState(selectedId, connectingFromId, node.id);
        emit(removeNodeOps(document_!, node.id));
        setSelectedId(next.selectedId);
        setConnectingFromId(next.connectingFromId);
        return;
      }
      if (action.kind === "move") {
        const rect = rectOf(node.id);
        if (rect) emit(pinNodeOps(node, moveCanvasRectWithKeyboard(rect, action.key, action.largeStep)));
        return;
      }
      const nextId = nextCanvasNodeId((document_?.nodes ?? []).map((candidate) => candidate.id), node.id, action.delta);
      if (nextId) {
        setFocusedId(nextId);
        nodeRefs.current.get(nextId)?.focus();
      }
    },
    [activateNode, connectingFromId, document_, emit, onOps, rectOf, selectedId]
  );

  const fitCanvas = useCallback(() => {
    const viewport = viewportRef.current?.getBoundingClientRect();
    if (!viewport || !document_) return;
    const rects = document_.nodes.map((node) => rectOf(node.id)).filter((rect): rect is CanvasRect => !!rect);
    const fitted = fitCanvasTransform(rects, viewport, 24, MAX_SCALE);
    setScale(fitted.scale);
    setOffset(fitted.offset);
  }, [document_, rectOf]);

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-canvas-node]");
    const id = card?.dataset.canvasNode ?? nodeAtPoint(event.clientX, event.clientY);
    if (!id || !document_) return;
    const node = document_.nodes.find((candidate) => candidate.id === id);
    if (node) openSource(node);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
      return;
    }
    if (event.key === "Escape") {
      setSelectedId(null);
      setConnectingFromId(null);
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
      event.preventDefault();
      removeSelected();
    }
  };

  if (!document_ || document_.nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Boxes className="h-5 w-5 text-content-muted" />
        <div className="text-regular font-medium text-content-secondary">Canvas is empty</div>
        <p className="max-w-md text-compact leading-5 text-content-muted">
          Ask an agent to add nodes, or edit the file directly in Raw. Nodes without a position are arranged
          automatically; dragging one pins it where you put it.
        </p>
      </div>
    );
  }

  const rects = document_.nodes.map((node) => rectOf(node.id)).filter((rect): rect is CanvasRect => !!rect);
  const extent = {
    width: Math.max(...rects.map((rect) => rect.x + rect.w), 0) + CONTENT_PAD,
    height: Math.max(...rects.map((rect) => rect.y + rect.h), 0) + CONTENT_PAD,
  };
  const readOnly = !onOps;
  const activeTabId =
    (focusedId && document_.nodes.some((node) => node.id === focusedId) ? focusedId : null) ??
    (selectedId && document_.nodes.some((node) => node.id === selectedId) ? selectedId : null) ??
    document_.nodes[0]?.id;

  return (
    <div className="relative flex h-full min-h-0">
      <div
        ref={viewportRef}
        role="application"
        aria-label="Canvas"
        tabIndex={0}
        // `select-none`: on this surface a left drag MOVES a node, so it can never also be
        // a text selection — and without this the browser painted one anyway, which then
        // popped the selection toolbar on top of the node you just dragged. Picking and
        // annotating a node go through the right-click menu, which addresses the whole
        // node (`sourcePath: ["nodes", at]`) rather than whatever text a drag swept over.
        className="relative min-w-0 flex-1 select-none overflow-hidden outline-none touch-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={() => {
          gesture.current = null;
          moved.current = false;
          setDragging(null);
          setWire(null);
        }}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        <div
          role="listbox"
          aria-label="Canvas nodes"
          aria-describedby="canvas-keyboard-help"
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: extent.width, height: extent.height, transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
            {document_.edges.map((edge) => {
              const from = rectOf(edge.from.node);
              const to = rectOf(edge.to.node);
              if (!from || !to) return null;
              const fromSide = edge.from.side ?? facing(from, to);
              const toSide = edge.to.side ?? facing(to, from);
              const a = anchorOf(from, fromSide);
              const b = anchorOf(to, toSide);
              return (
                <g key={edge.id}>
                  <path d={curve(a, fromSide, b, toSide)} fill="none" stroke="rgb(var(--tone-zinc-600))" strokeWidth="1.25" />
                  {edge.label && (
                    <text
                      x={(a.x + b.x) / 2}
                      y={(a.y + b.y) / 2 - 6}
                      textAnchor="middle"
                      fontSize="var(--type-minimal-size)"
                      fill="rgb(var(--text-muted))"
                    >
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}
            {wire &&
              (() => {
                const from = rectOf(wire.from);
                if (!from) return null;
                const a = anchorOf(from, wire.side);
                return (
                  <path
                    d={curve(a, wire.side, wire, facing({ ...wire, w: 0, h: 0 }, from))}
                    fill="none"
                    stroke="rgb(var(--tone-indigo-400))"
                    strokeWidth="1.5"
                    strokeDasharray="4 4"
                  />
                );
              })()}
          </svg>

          {document_.nodes.map((node) => {
            const rect = rectOf(node.id);
            if (!rect) return null;
            const selected = selectedId === node.id;
            return (
              <div
                key={node.id}
                ref={(element) => {
                  if (element) nodeRefs.current.set(node.id, element);
                  else nodeRefs.current.delete(node.id);
                }}
                data-canvas-node={node.id}
                data-workbench-context-target="canvas-node"
                role="option"
                aria-selected={selected}
                aria-label={`${nodeTitle(node)}${node.rect ? ", pinned" : ""}`}
                tabIndex={activeTabId === node.id ? 0 : -1}
                className={`absolute flex flex-col rounded-sm elevation-raised ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                  selected ? "bg-selected ring-selected-indicator" : "bg-panel ring-zinc-700 hover:ring-zinc-500"
                }`}
                style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: node.z ?? 0 }}
                onContextMenu={(event) =>
                  requestContextPick?.(event, { label: nodeTitle(node), sourcePath: ["nodes", node.at] })
                }
                onKeyDown={(event) => onNodeKeyDown(event, node)}
                onFocus={() => setFocusedId(node.id)}
                onDoubleClick={() => openSource(node)}
              >
                <div className="flex flex-shrink-0 items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-compact font-medium text-content-primary">{nodeTitle(node)}</span>
                  {node.rect && <span className="flex-shrink-0 text-minimal text-content-muted">pinned</span>}
                </div>
                <NodeBody node={node} />
                {selected && !readOnly &&
                  SIDES.map((side) => (
                    <span
                      key={side}
                      data-canvas-port={node.id}
                      data-canvas-side={side}
                      aria-hidden="true"
                      className="absolute z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-sm bg-indigo-400 ring-1 ring-panel"
                      style={{
                        left: side === "left" ? 0 : side === "right" ? rect.w : rect.w / 2,
                        top: side === "top" ? 0 : side === "bottom" ? rect.h : rect.h / 2,
                      }}
                    />
                  ))}
              </div>
            );
          })}
        </div>

        <p id="canvas-keyboard-help" className="sr-only">
          Use arrow keys to move focus between nodes. Press Enter or Space to select. Hold Alt while pressing an arrow key to move a node; add Shift for a larger step. Use Connect selected node, then activate a target node, to create an edge.
        </p>

        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex items-end gap-3 opacity-0 transition-opacity duration-150 group-hover/floating-panel:opacity-100 group-focus-within/floating-panel:opacity-100 max-md:opacity-100">
          <div className="floating-control-surface pointer-events-auto flex items-center gap-1 rounded-concentric p-1">
            <UiButton
              variant="plain"
              type="button"
              onClick={undo}
              disabled={readOnly}
              aria-label="Undo"
              content="icon"
              controlSize={FLOATING_CHROME_CONTROL_SIZE}
              className="flex items-center justify-center rounded-sm text-content-primary hover:bg-control hover:text-content-strong"
            >
              <Undo2 className="h-4 w-4" />
            </UiButton>
            <UiButton
              variant="plain"
              type="button"
              onClick={removeSelected}
              disabled={readOnly || !selectedId}
              aria-label="Delete selected node"
              content="icon"
              controlSize={FLOATING_CHROME_CONTROL_SIZE}
              className="flex items-center justify-center rounded-sm text-content-primary hover:bg-control hover:text-danger-400"
            >
              <Trash2 className="h-4 w-4" />
            </UiButton>
            <UiButton
              variant="plain"
              type="button"
              onClick={() => setConnectingFromId((current) => current ? null : selectedId)}
              disabled={readOnly || !selectedId}
              aria-label={connectingFromId ? "Cancel connection" : "Connect selected node"}
              aria-pressed={!!connectingFromId}
              content="icon"
              controlSize={FLOATING_CHROME_CONTROL_SIZE}
              className="flex items-center justify-center rounded-sm text-content-primary hover:bg-control hover:text-content-strong"
            >
              <Link2 className="h-4 w-4" />
            </UiButton>
            <UiButton
              variant="plain"
              type="button"
              onClick={() => {
                const node = document_?.nodes.find((candidate) => candidate.id === selectedId);
                if (node) openSource(node);
              }}
              disabled={!selectedId || document_?.nodes.find((node) => node.id === selectedId)?.kind !== "source" || !openLocator}
              aria-label="Open selected source in Workbench"
              content="icon"
              controlSize={FLOATING_CHROME_CONTROL_SIZE}
              className="flex items-center justify-center rounded-sm text-content-primary hover:bg-control hover:text-content-strong"
            >
              <ExternalLink className="h-4 w-4" />
            </UiButton>
            {connectingFromId && <span role="status" className="px-2 text-minimal text-content-muted">Choose a target node</span>}
          </div>
          <div className="flex-1" />
          <div className="floating-control-surface pointer-events-auto flex items-center rounded-concentric p-1">
            <UiButton variant="plain" type="button" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out" content="icon" controlSize={FLOATING_CHROME_CONTROL_SIZE} className="flex items-center justify-center rounded-sm text-content-primary hover:bg-control hover:text-content-strong">
              <Minus className="h-4 w-4" />
            </UiButton>
            <span className="w-12 text-center text-minimal tabular-nums text-content-muted">{Math.round(scale * 100)}%</span>
            <UiButton variant="plain" type="button" onClick={() => zoom(1.2)} aria-label="Zoom in" content="icon" controlSize={FLOATING_CHROME_CONTROL_SIZE} className="flex items-center justify-center rounded-sm text-content-primary hover:bg-control hover:text-content-strong">
              <Plus className="h-4 w-4" />
            </UiButton>
            <UiButton variant="plain" type="button" onClick={() => { setScale(1); setOffset({ x: 24, y: 24 }); }} aria-label="Reset view" content="icon" controlSize={FLOATING_CHROME_CONTROL_SIZE} className="flex items-center justify-center rounded-sm text-content-primary hover:bg-control hover:text-content-strong">
              <RotateCcw className="h-4 w-4" />
            </UiButton>
            <UiButton variant="plain" type="button" onClick={fitCanvas} aria-label="Fit canvas" content="icon" controlSize={FLOATING_CHROME_CONTROL_SIZE} className="flex items-center justify-center rounded-sm text-content-primary hover:bg-control hover:text-content-strong">
              <Maximize2 className="h-4 w-4" />
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  );
}
