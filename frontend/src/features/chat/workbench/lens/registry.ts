import type { ReactNode } from "react";

// A Lens is a generic, reusable renderer: (data, config) -> editable UI.
// Templates pick lenses declaratively (data), so a lens is the compiled "vocabulary"
// that makes data-only extensions possible. Adding a NEW kind of UI = add a lens (code);
// using existing UI = pure data in a manifest (no code).
export interface LensProps {
  data: unknown;
  config: unknown;
  onChange: (next: unknown) => void;
  /** Suppress every edit affordance. Set by the HOST from the data's SOURCE, not by the
   *  lens: a projection read from a resource verb carries no version to write back
   *  against, so an edit control over it promises something that cannot happen. An inert
   *  onChange is not enough — the affordance itself has to be absent. Distinct from
   *  `Lens.viewOnly`, which is a lens saying it never edits ANY data. */
  readOnly?: boolean;
}

export interface Lens {
  id: string;
  // never calls onChange (machine-written data, humans only view) — hosts hide Save,
  // so a stale snapshot can't be written back over a concurrent agent write
  viewOnly?: boolean;
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
