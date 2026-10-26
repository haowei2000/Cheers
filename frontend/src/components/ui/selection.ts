/**
 * The one selected-state recipe. Every primitive that can be selected composes
 * the shared surface with exactly one marker; feature code passes `selected`
 * to a primitive and never assembles these classes itself.
 */

/** Neutral selected fill, including hover and pressed states. */
export const selectedSurfaceClasses = "bg-selected hover:bg-selected-hover active:bg-selected-active";

/** Selected label foreground for controls and rows, whose text is a label. */
export const selectedLabelClasses = "text-content-strong font-semibold hover:text-content-strong";

/**
 * Marker that accompanies the surface:
 * - `ring` for controls, options, and canvas objects
 * - `rail` for list rows (pairs with the row's `border-l-2`)
 * - `underline` for tabs (pairs with `tabBaseClasses`)
 */
export const selectionMarkerClasses = {
  ring: "ring-1 ring-inset ring-selected-indicator/70",
  rail: "border-l-selected-indicator",
  underline: "border-content-strong",
} as const;

export type SelectionMarker = keyof typeof selectionMarkerClasses;

/** Surface, label, and marker for a selected control, row, or option. */
export function selectedClasses(marker: Exclude<SelectionMarker, "underline">): string {
  return `${selectedSurfaceClasses} ${selectedLabelClasses} ${selectionMarkerClasses[marker]}`;
}

/**
 * Surface and ring for a selected content container (a message, canvas node,
 * or card). Body copy keeps its own weight and colour.
 */
export const selectedContainerClasses = `${selectedSurfaceClasses} ${selectionMarkerClasses.ring}`;

export type TabOrientation = "horizontal" | "vertical";

/** Horizontal tabs stay transparent; selection is the underline plus strong text. */
export const tabBaseClasses = "rounded-none border-b-2 bg-transparent ring-0 shadow-none hover:bg-transparent";
export const tabSelectedClasses = `${selectionMarkerClasses.underline} ${selectedLabelClasses}`;
export const tabRestingClasses = "border-transparent text-content-primary hover:text-content-strong";

/** Vertical tabs stack like list rows, so selection is the row rail. */
export const verticalTabBaseClasses = "rounded-none border-l-2 ring-0 shadow-none";
export const verticalTabRestingClasses = "border-l-transparent bg-transparent text-content-primary hover:bg-control hover:text-content-strong";

export function tabClasses(selected: boolean, orientation: TabOrientation = "horizontal"): string {
  if (orientation === "vertical") {
    return `${verticalTabBaseClasses} ${selected ? selectedClasses("rail") : verticalTabRestingClasses}`;
  }
  return `${tabBaseClasses} ${selected ? tabSelectedClasses : tabRestingClasses}`;
}

/**
 * Keyboard or pointer highlight in a listbox (the active descendant). It reads
 * as hover, never as selection, so a highlighted row and the chosen row stay
 * distinguishable.
 */
export const highlightedClasses = "bg-control-hover text-content-strong";
