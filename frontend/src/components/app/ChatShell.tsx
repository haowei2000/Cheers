import { useEffect, useRef, type ReactNode } from "react";
import type { Workspace } from "../../types";
import { WorkspaceRail } from "../WorkspaceRail";

interface ChatShellProps {
  children: ReactNode;
  appInert?: boolean;
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
  appInert = false,
  isMobile,
  onCloseSidebar,
  onCreateWorkspace,
  onSelectWorkspace,
  selectedWorkspaceId,
  sidebar,
  sidebarOpen,
  workspaces,
}: ChatShellProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (appInert) {
      shell.setAttribute("inert", "");
    } else {
      shell.removeAttribute("inert");
    }
  }, [appInert]);

  return (
    <div
      ref={shellRef}
      aria-hidden={appInert || undefined}
      className="an-app-shell flex min-h-0 overflow-hidden"
      style={{
        background: "var(--bg-0)",
        height: "var(--an-viewport-height, 100dvh)",
      }}
    >
      {isMobile && sidebarOpen && (
        <div
          className="an-mobile-backdrop fixed inset-0 bg-black/50 z-[55]"
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
