import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Settings, LogOut, MessageSquare, Plus, Radar, Users } from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { getFleetBadge } from "@/api/fleet";
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

  // Pending-approvals badge on the Fleet button. Cheap count endpoint, polled
  // slowly + refreshed on focus; the Fleet page itself is the live surface.
  const [fleetCount, setFleetCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      getFleetBadge()
        .then((r) => alive && setFleetCount(r.count))
        .catch(() => {});
    load();
    const t = window.setInterval(load, 60_000);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener("focus", load);
    };
  }, []);

  return (
    <div className="w-14 h-full bg-rail flex flex-col items-center py-3 gap-2 flex-shrink-0 border-r border-zinc-800/40 max-md:pt-[calc(0.75rem+env(safe-area-inset-top))] max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
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
          <MessageSquare className="w-5 h-5 text-white" />
        </div>
      </RailButton>

      <div className="w-8 h-px bg-zinc-700/60 my-1" />

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
          className="w-10 h-10 max-md:w-11 max-md:h-11 rounded-2xl border-2 border-dashed border-zinc-700 text-zinc-500 hover:border-indigo-500 hover:text-indigo-400 flex items-center justify-center transition-colors flex-shrink-0"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom actions */}
      <div className="flex flex-col items-center gap-2 mt-auto">
        <NotificationCenter />

        <button
          onClick={() => {
            onAction?.();
            navigate("/fleet");
          }}
          title="Fleet — agent status & approvals"
          className="relative w-8 h-8 max-md:w-11 max-md:h-11 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <Radar className="w-4 h-4" />
          {fleetCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] px-1.5 py-0.5 rounded-full bg-amber-600 text-white text-[10px] font-bold flex items-center justify-center">
              {fleetCount}
            </span>
          )}
        </button>

        <button
          onClick={() => {
            onAction?.();
            navigate("/friends");
          }}
          title="Friends"
          className="w-8 h-8 max-md:w-11 max-md:h-11 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <Users className="w-4 h-4" />
        </button>

        <button
          onClick={() => {
            onAction?.();
            navigate("/settings");
          }}
          title="Settings"
          className="w-8 h-8 max-md:w-11 max-md:h-11 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>

        <div className="w-px h-4 bg-zinc-700/60" />

        {/* Static identity mark — not interactive (no false click affordance). */}
        <Avatar
          name={user?.display_name ?? user?.username}
          id={user?.user_id}
          size="sm"
        />

        <button
          onClick={handleLogout}
          title="Sign out"
          aria-label="Sign out"
          className="w-8 h-8 max-md:w-11 max-md:h-11 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>

      {wsOpen && <NewWorkspaceDialog onClose={() => setWsOpen(false)} />}
    </div>
  );
}
