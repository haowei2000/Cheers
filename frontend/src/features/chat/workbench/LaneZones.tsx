import { useSyncExternalStore } from "react";
import {
  getSnapState,
  resolveZone,
  subscribeSnap,
  zonesFor,
} from "./laneSnap";

// Drag affordance for the work lane: while a window is being dragged (the snap
// store is `active`), this paints the partition grid over the lane and lights up
// the zone the cursor is over — the spot the window will snap to on drop. Purely
// visual: `pointer-events-none` so it never intercepts the drag, and it renders
// nothing when no drag is in progress. Rendered as an `inset-0` child of the
// `relative` lane so its lane-local coords line up with the floating windows.
export function LaneZones() {
  const snap = useSyncExternalStore(subscribeSnap, getSnapState, getSnapState);
  if (!snap.active || !snap.bounds) return null;
  const zones = zonesFor(snap.bounds);
  if (!zones.length) return null;
  const target = snap.pointer ? resolveZone(snap.pointer, snap.bounds) : null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[45] max-md:hidden"
      aria-hidden
    >
      {zones.map((z) => {
        const hot = target?.id === z.id;
        return (
          <div
            key={z.id}
            className={
              hot
                ? "absolute rounded-xl border-2 border-indigo-400/80 bg-indigo-500/20 transition-colors"
                : "absolute rounded-xl border border-dashed border-zinc-500/40 bg-zinc-100/[0.03] transition-colors"
            }
            style={{ left: z.x, top: z.y, width: z.w, height: z.h }}
          />
        );
      })}
    </div>
  );
}
