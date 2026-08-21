import { FolderTree, LayoutDashboard, PanelRight, Paperclip, type LucideIcon } from "lucide-react";
import type { SpawnKind } from "@/features/chat/workbench/laneSnap";

// The four windows the work lane can host.
//
// A window and a board are TWO CONCEPTS THAT SHARE IDENTITY, NOT RENDERING — the answer
// to the open question docs/arch/PANEL_MODEL.md carried. The windows take wildly
// different props (RemoteWorkspaceDialog alone takes nine, including presence and
// bot-scoped signals), so one `render(ctx)` contract would need the god-context
// PanelContext exists to avoid. But `{id, title, icon}` plus open state is common, and
// that is all a picker needs to list them beside the boards.
//
// So this is a descriptor list, not a registry: ChannelView still renders each window
// itself with its own props. Ids are the existing SpawnKind union — the lane already
// names these four for snap placement, and inventing a second vocabulary for the same
// four things is how drift starts.

export interface LaneWindowDescriptor {
  id: SpawnKind;
  title: string;
  icon: LucideIcon;
}

export const LANE_WINDOWS: readonly LaneWindowDescriptor[] = [
  { id: "files", title: "Channel files", icon: Paperclip },
  { id: "workspace", title: "Remote workspace", icon: FolderTree },
  { id: "viewboard", title: "ViewBoard", icon: LayoutDashboard },
  { id: "workbench", title: "Workbench", icon: PanelRight },
];
