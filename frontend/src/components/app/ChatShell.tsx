import type { ReactNode } from "react";
import type { Workspace } from "../../types";
import { WorkspaceRail } from "../WorkspaceRail";

interface ChatShellProps {
  children: ReactNode;
  isMobile: boolean;
  onCloseSidebar: () => void;
  onCreateWorkspace: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  selectedWorkspaceId: string;
  sidebar: ReactNode;
  sidebarOpen: boolean;
  workspaces: Workspace[];
}

export function ChatShell({
  children,
  isMobile,
  onCloseSidebar,
  onCreateWorkspace,
  onSelectWorkspace,
  selectedWorkspaceId,
  sidebar,
  sidebarOpen,
  workspaces,
}: ChatShellProps) {
  return (
    <div className="flex h-dvh" style={{ background: "var(--bg-0)" }}>
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-[55]"
          onClick={onCloseSidebar}
        />
      )}
      {!isMobile && (
        <WorkspaceRail
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelect={onSelectWorkspace}
          onCreate={onCreateWorkspace}
        />
      )}
      {sidebar}
      {children}
    </div>
  );
}
