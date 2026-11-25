import { isCanvasPath } from "../workbench/sceneState";

/** A canvas with nothing on it yet. `canvas: 1` is what makes the Workbench offer the
 *  canvas view; the empty lists give an agent or a person somewhere to add to. */
export const EMPTY_CANVAS = "canvas: 1\nnodes: []\nedges: []\n";

/** Where a canvas named in the library lands. A bare name goes in `canvases/` and gets
 *  the canvas suffix; a name that already has a folder or the suffix is kept as typed,
 *  so the field never fights someone who knows the path they want. */
export function canvasPathFor(name: string): string | null {
  const trimmed = name.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed.endsWith("/")) return null;
  const file = isCanvasPath(trimmed) ? trimmed : `${trimmed}.canvas.yaml`;
  return file.includes("/") ? file : `canvases/${file}`;
}
