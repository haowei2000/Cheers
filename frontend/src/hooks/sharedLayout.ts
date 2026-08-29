import { createContext } from "react";
import type { Rect, SpawnKind } from "@/features/chat/workbench/laneSnap";

// The channel's shared window arrangement, published the same way LaneBoundsContext
// publishes the lane box: FloatingPanel reads it directly, so the four windows do not
// each grow a prop for something none of them own.
//
// `geomFor` answers in LANE PIXELS (the provider resolves the stored fraction against
// the live lane), or null when the channel has no placement for that window. A `null`
// provider means no shared layout at all — mobile, or a panel floating over the
// viewport rather than inside the lane.
//
// See features/chat/workbench/sharedLayout.ts for what is stored and why, and
// features/chat/hooks/useChannelLayout.ts for the provider.
export const SharedLayoutContext = createContext<((kind: SpawnKind) => Rect | null) | null>(null);
