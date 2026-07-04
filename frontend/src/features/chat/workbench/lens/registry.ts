import type { ReactNode } from "react";

// A Lens is a generic, reusable renderer: (data, config) -> editable UI.
// Templates pick lenses declaratively (data), so a lens is the compiled "vocabulary"
// that makes data-only plugins possible. Adding a NEW kind of UI = add a lens (code);
// using existing UI = pure data in a manifest (no code).
export interface LensProps {
  data: unknown;
  config: unknown;
  onChange: (next: unknown) => void;
}

export interface Lens {
  id: string;
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
