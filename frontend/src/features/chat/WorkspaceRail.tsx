import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Settings, LogOut, MessageSquare, Plus, Users } from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { useChatStore } from "@/stores/chatStore";
import { useAuthStore } from "@/stores/authStore";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
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
      className="group relative w-10 h-10 flex items-center justify-center"
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

export function WorkspaceRail() {
  const navigate = useNavigate();
  const { workspaces, personalWorkspace, selectedWorkspaceId, selectWorkspace } =
    useChatStore();
  const { user, logout } = useAuthStore();
  const [wsOpen, setWsOpen] = useState(false);
  const personalSelected =
    !!personalWorkspace && selectedWorkspaceId === personalWorkspace.workspace_id;

  function handleLogout() {
    logout();
    toast.success("Logged out");
    navigate("/login", { replace: true });
  }

  return (
    <div className="w-14 bg-rail flex flex-col items-center py-3 gap-2 flex-shrink-0 border-r border-zinc-800/40">
      {/* Personal workspace — the user's home (DMs + private space), the most important
          one, so it takes the prominent top slot. Selectable; falls back to a static brand
          mark until it's loaded. */}
      <RailButton
        selected={personalSelected}
        onClick={() => personalWorkspace && selectWorkspace(personalWorkspace.workspace_id)}
        disabled={!personalWorkspace}
        title={personalWorkspace ? "Personal（私信 / 个人空间）" : "Cheers"}
      >
        <div
          className={cn(
            "w-10 h-10 bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-500/20 transition-all duration-150",
            personalSelected ? "rounded-2xl" : "rounded-xl group-hover:rounded-2xl"
          )}
        >
          <MessageSquare className="w-5 h-5 text-white" />
        </div>
      </RailButton>

      <div className="w-8 h-px bg-zinc-700/60 my-1" />

      {/* Team workspaces (personal is the top slot, never listed here) */}
      <div className="flex flex-col items-center gap-2 flex-1">
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
            onClick={() => selectWorkspace(ws.workspace_id)}
          />
        ))}

        <button
          title="Add workspace"
          onClick={() => setWsOpen(true)}
          className="w-10 h-10 rounded-2xl border-2 border-dashed border-zinc-700 text-zinc-600 hover:border-indigo-500 hover:text-indigo-400 flex items-center justify-center transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom actions */}
      <div className="flex flex-col items-center gap-2 mt-auto">
        <button
          onClick={() => navigate("/friends")}
          title="Friends"
          className="w-8 h-8 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <Users className="w-4 h-4" />
        </button>

        <button
          onClick={() => navigate("/settings")}
          title="Settings"
          className="w-8 h-8 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>

        <button
          onClick={handleLogout}
          title="Sign out"
          className="w-8 h-8 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>

        <div className="w-px h-4 bg-zinc-700/60" />

        <Avatar
          name={user?.display_name ?? user?.username}
          id={user?.user_id}
          size="sm"
          className="cursor-pointer hover:opacity-80 transition-opacity"
        />
      </div>

      {wsOpen && <NewWorkspaceDialog onClose={() => setWsOpen(false)} />}
    </div>
  );
}
