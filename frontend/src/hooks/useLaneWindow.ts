import { createContext, useContext } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWindowDrag, type WindowDrag } from "@/hooks/useWindowDrag";

// The work lane publishes its live bounding rect (viewport coords) here so the
// instrument panels floating inside it know the box to drag/resize within.
// `null` provider = no lane (mobile, or a window that floats over the viewport
// like the Channel files dialog).
export const LaneBoundsContext = createContext<(() => DOMRect | null) | null>(null);

export interface LaneWindow {
  /** Render as a draggable/resizable floating window: desktop AND inside a lane. */
  float: boolean;
  isMobile: boolean;
  /** Drag/resize/stacking + snap-to-zone state (see useWindowDrag). Inert when
   *  not floating. */
  drag: WindowDrag;
}

// Shared wiring for the lane's instrument windows (ViewBoard / Workbench /
// Remote workspace / Channel files). Each panel keeps its own chrome and just
// spreads `drag.handleProps` onto its title bar and renders a ResizeGrip; this
// hook decides whether it floats (desktop, in a lane), binds it to the lane
// bounds, and turns on FancyZones-style snapping (the LaneZones overlay lights
// up the target zone; drop snaps position+size to it).
export function useLaneWindow(storageKey: string): LaneWindow {
  const isMobile = useIsMobile();
  const getBounds = useContext(LaneBoundsContext);
  const float = !isMobile && getBounds != null;
  const drag = useWindowDrag(storageKey, !isMobile, float ? getBounds! : undefined, float);
  return { float, isMobile, drag };
}
