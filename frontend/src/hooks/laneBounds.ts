import { createContext } from "react";

// The channel's floating canvas publishes its live bounding rect (viewport coords) here so the
// instrument panels floating inside it know the box to drag/resize within.
// `null` provider = no canvas (mobile, or a window that floats over the viewport
// like an anchored inspector).
//
// This used to sit beside a `useLaneWindow` hook that wired float/drag/snap for the
// two hand-rolled drawers. Both now render through FloatingPanel, which does that
// wiring itself, so only the context remains. See docs/arch/PANEL_MODEL.md.
export const LaneBoundsContext = createContext<(() => DOMRect | null) | null>(null);
