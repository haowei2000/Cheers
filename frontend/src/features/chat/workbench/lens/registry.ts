import type { MouseEvent, ReactNode } from "react";
import type { PatchOp } from "../patchOps";

export interface LensContextTarget {
  label: string;
  sourcePath?: ReadonlyArray<string | number>;
  sourceText?: string;
}

// A Lens is a generic, reusable renderer: (data, config) -> editable UI.
// Templates pick lenses declaratively (data), so a lens is the compiled "vocabulary"
// that makes data-only extensions possible. Adding a NEW kind of UI = add a lens (code);
// using existing UI = pure data in a manifest (no code).
export interface LensProps {
  data: unknown;
  config: unknown;
  onChange: (next: unknown) => void;
  /** Structured edit, for a lens that knows WHICH part changed. Preferred over
   *  `onChange` for machine-edited documents: the host routes it to `fs.patch`, which
   *  keeps YAML comments across an array length change and can replay after a
   *  conflict. Absent when the host has no ops path — fall back to `onChange`. */
  onOps?: (ops: readonly PatchOp[]) => void;
  /** Suppress every edit affordance. Set by the HOST from the data's SOURCE, not by the
   *  lens: a projection read from a resource verb carries no version to write back
   *  against, so an edit control over it promises something that cannot happen. An inert
   *  onChange is not enough — the affordance itself has to be absent. Distinct from
   *  `Lens.viewOnly`, which is a lens saying it never edits ANY data. */
  readOnly?: boolean;
  requestContextPick?: (event: MouseEvent<Element>, target: LensContextTarget) => void;
}

export interface Lens {
  id: string;
  contextPick: "granular";
  // never calls onChange (machine-written data, humans only view) — hosts hide Save,
  // so a stale snapshot can't be written back over a concurrent agent write
  viewOnly?: boolean;
  /** This lens writes each edit as it happens, through `onOps`. The host must not offer
   *  a Save: there is no unsaved buffer to flush, and a whole-document write would undo
   *  exactly what the ops path protects — the comments an array length change loses, and
   *  the concurrent agent edit a stale document would clobber. Distinct from `viewOnly`,
   *  which says the lens never edits at all. */
  savesItself?: boolean;
  render: (props: LensProps) => ReactNode;
}

const lenses: Record<string, Lens> = {};

export function registerLens(lens: Lens): void {
  lenses[lens.id] = lens;
}

export function getLens(id: string): Lens | undefined {
  return lenses[id];
}

export function lensIds(): string[] {
  return Object.keys(lenses);
}
