// Single source of truth for the "add to context" UI vocabulary.
//
// Before this, the same act — attach a Cheers resource to the next message's
// `context_bundle` — wore three head verbs across five surfaces ("Add context" in
// the composer, "Attach" in the RemoteWorkspace dialog, "Attach this file/board/the
// selected lines" in the Workbench). One head verb now: **"Add … to context"**, the
// object explicit, the scope always "your next message". Every surface reads its
// labels from here.

/** The composer's umbrella menu button (opens the quick-pick). */
export const ADD_CONTEXT_MENU = "Add context";

/** Tooltip for the composer menu button. */
export const ADD_CONTEXT_MENU_TITLE =
  "Add Cheers resources (plan, decisions, files, …) as context for your next message";

/** Post-add state shown on an attach control that has already added its item. */
export const ADDED_TO_CONTEXT_TITLE = "Added to context";

/** Short visible label for a per-item attach control (e.g. RemoteWorkspace file). */
export const ADD_TO_CONTEXT = "Add to context";
/** Its post-add visible text. */
export const ADDED_TO_CONTEXT = "Added";

/** Tooltip for attaching a specific object, e.g. `addToContextTitle("this file")`
 *  → "Add this file to context for your next message". */
export function addToContextTitle(what: string): string {
  return `Add ${what} to context for your next message`;
}
