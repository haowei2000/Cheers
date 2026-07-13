import { createContext, useContext } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";

// The work lane tiles its instrument windows (ViewBoard / Workbench / Remote
// workspace / Channel files) in an auto-grid that reflows as windows open and
// close. This context tells each window it lives in that grid, so it renders as
// a full-cell block the grid sizes and positions — not a free-floating,
// overlapping draggable card. `null` = no lane grid (mobile full-screen sheets,
// or a panel floating over the viewport).
export const LaneLayoutContext = createContext<"grid" | null>(null);

export interface LaneWindow {
  /** Render as a tiled grid cell: desktop AND inside the lane grid. */
  grid: boolean;
  isMobile: boolean;
}

// Shared wiring for the lane's instrument windows: each panel keeps its own
// chrome and asks this hook whether it should render as a grid cell (desktop, in
// the lane) or a full-screen sheet (mobile).
export function useLaneWindow(): LaneWindow {
  const isMobile = useIsMobile();
  const layout = useContext(LaneLayoutContext);
  const grid = !isMobile && layout === "grid";
  return { grid, isMobile };
}
