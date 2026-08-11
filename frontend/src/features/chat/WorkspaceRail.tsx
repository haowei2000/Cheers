import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Settings, LogOut, Plus, Users } from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { EditorialIcon } from "@/components/ui/editorial-icons";
import { useChatStore } from "@/stores/chatStore";
import { useAuthStore } from "@/stores/authStore";
import { disablePush } from "@/lib/push";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import { NotificationCenter } from "./NotificationCenter";
import type { Workspace } from "@/types";

// Shared rail-button shell: the left selection indicator bar + hover state. Children are
// the inner visual (a workspace Avatar, or the personal/brand icon box).
function RailButton({
  selected,
  onClick,
  title,
  disabled,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="group relative w-10 h-10 max-md:w-11 max-md:h-11 flex items-center justify-center"
    >
      <div
        className={cn(
          "absolute left-0 w-1 rounded-r-full bg-zinc-100 transition-all duration-150",
          selected ? "h-5" : "h-0 group-hover:h-2"
        )}
      />
      {children}
    </button>
  );
}

function WorkspaceButton({
  workspace,
  selected,
  onClick,
}: {
  workspace: Workspace;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <RailButton selected={selected} onClick={onClick} title={workspace.name}>
      <Avatar
        name={workspace.name}
        src={workspace.avatar_url}
        id={workspace.workspace_id}
        size="sm"
        className={cn(
          "transition-all duration-150 rounded-xl",
          selected ? "rounded-2xl" : "rounded-xl group-hover:rounded-2xl"
        )}
      />
    </RailButton>
  );
}

export function WorkspaceRail({
  onAction,
}: {
  /** Mobile drawer mode: called after a workspace pick / navigation so the layout
   *  can close the drawer. Buttons that open a dialog do NOT fire it (the dialog
   *  renders inside the drawer and would be unmounted). */
  onAction?: () => void;
} = {}) {
  const navigate = useNavigate();
  const { workspaces, personalWorkspace, selectedWorkspaceId, selectWorkspace } =
    useChatStore();
  const { user, logout } = useAuthStore();

  async function handleLogout() {
    // Drop the push subscription while the auth token is still valid — a
    // signed-out browser must not keep receiving lock-screen notifications.
    await disablePush().catch(() => {});
    logout();
    toast.success("Logged out");
    navigate("/login", { replace: true });
  }
  const [wsOpen, setWsOpen] = useState(false);
  const personalSelected =
    !!personalWorkspace && selectedWorkspaceId === personalWorkspace.workspace_id;

  return (
    <div className="w-14 h-full bg-rail flex flex-col items-center py-3 gap-2 flex-shrink-0 max-md:pt-[calc(0.75rem+env(safe-area-inset-top))] max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      {/* Personal workspace — the user's home (DMs + private space), the most important
          one, so it takes the prominent top slot. Selectable; falls back to a static brand
          mark until it's loaded. */}
      <RailButton
        selected={personalSelected}
        onClick={() => {
          if (!personalWorkspace) return;
          selectWorkspace(personalWorkspace.workspace_id);
          onAction?.();
        }}
        disabled={!personalWorkspace}
        title={personalWorkspace ? "Personal (DMs / personal space)" : "Cheers"}
      >
        <div
          className={cn(
            "w-10 h-10 max-md:w-11 max-md:h-11 bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-500/20 transition-all duration-150",
            personalSelected ? "rounded-2xl" : "rounded-xl group-hover:rounded-2xl"
          )}
        >
          <EditorialIcon name="correspondence" className="h-5 w-5 text-white" />
        </div>
      </RailButton>

      {/* The personal workspace and team list are grouped by a small visual
          pause instead of a hard rule. */}
      <div className="h-2 flex-shrink-0" aria-hidden />

      {/* Team workspaces (personal is the top slot, never listed here) */}
      <div className="flex flex-col items-center gap-2 flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {workspaces
          .filter(
            (ws) =>
              ws.kind !== "personal" &&
              ws.workspace_id !== personalWorkspace?.workspace_id
          )
          .map((ws) => (
          <WorkspaceButton
            key={ws.workspace_id}
            workspace={ws}
            selected={selectedWorkspaceId === ws.workspace_id}
            onClick={() => {
              selectWorkspace(ws.workspace_id);
              onAction?.();
            }}
          />
        ))}

        <button
          title="Add workspace"
          onClick={() => setWsOpen(true)}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-indigo-400 max-md:h-11 max-md:w-11"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom actions */}
      <div className="flex flex-col items-center gap-2 mt-auto">
        <NotificationCenter />

        <IconButton
          onClick={() => {
            onAction?.();
            navigate("/fleet");
          }}
          label="Fleet — bots & status"
          presentationLevel="minimal"
          className="relative text-zinc-500"
        >
          <EditorialIcon name="agentMark" className="h-4 w-4" />
        </IconButton>

        <IconButton
          onClick={() => {
            onAction?.();
            navigate("/friends");
          }}
          label="Friends"
          presentationLevel="minimal"
          className="text-zinc-500"
        >
          <Users className="w-4 h-4" />
        </IconButton>

        <IconButton
          onClick={() => {
            onAction?.();
            navigate("/settings");
          }}
          label="Settings"
          presentationLevel="minimal"
          className="text-zinc-500"
        >
          <Settings className="w-4 h-4" />
        </IconButton>

        <div className="w-px h-4 bg-zinc-700/60" />

        {/* Static identity mark — not interactive (no false click affordance). */}
        <Avatar
          name={user?.display_name ?? user?.username}
          id={user?.user_id}
          size="sm"
        />

        <IconButton
          onClick={handleLogout}
          label="Sign out"
          tone="danger"
          presentationLevel="minimal"
        >
          <LogOut className="w-4 h-4" />
        </IconButton>
      </div>

      {wsOpen && <NewWorkspaceDialog onClose={() => setWsOpen(false)} />}
    </div>
  );
}
