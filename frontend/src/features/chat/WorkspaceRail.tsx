import { Button as UiButton } from "@/components/ui/button";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Settings, LogOut, Plus, Users } from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { ControlSizeProvider, controlIconClasses } from "@/components/ui/control-size";
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
    <UiButton variant="plain"
      square
      controlSize="comfortable"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="group relative"
    >
      <div
        className={cn(
          "absolute left-0 w-1 rounded-r-full bg-zinc-100 transition-all duration-150",
          selected ? "h-5" : "h-0 group-hover:h-2"
        )}
      />
      {children}
    </UiButton>
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
        size="large"
        className={cn(
          "rounded-sm transition-colors duration-150",
          selected ? "bg-zinc-600" : "group-hover:bg-zinc-600"
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
    <ControlSizeProvider size="comfortable">
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
        <img
          src="/cheers-icon.svg"
          alt=""
          aria-hidden="true"
          className={cn(
            "h-9 w-9 rounded-sm object-cover transition-[filter,opacity] duration-150",
            personalSelected
              ? "brightness-110"
              : "opacity-80 group-hover:opacity-100 group-hover:brightness-110"
          )}
        />
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

        <IconButton
          label="Add workspace"
          onClick={() => setWsOpen(true)}
          className="text-zinc-500 hover:text-zinc-200"
        >
          <Plus className={controlIconClasses.comfortable} />
        </IconButton>
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
          className="relative text-zinc-500"
        >
          <EditorialIcon name="agentMark" contentSize="large" />
        </IconButton>

        <IconButton
          onClick={() => {
            onAction?.();
            navigate("/friends");
          }}
          label="Friends"
          className="text-zinc-500"
        >
          <Users className={controlIconClasses.comfortable} />
        </IconButton>

        <IconButton
          onClick={() => {
            onAction?.();
            navigate("/settings");
          }}
          label="Settings"
          className="text-zinc-500"
        >
          <Settings className={controlIconClasses.comfortable} />
        </IconButton>

        <div className="w-px h-4 bg-zinc-700/60" />

        {/* Static identity mark — not interactive (no false click affordance). */}
        <Avatar
          name={user?.display_name ?? user?.username}
          id={user?.user_id}
          size="large"
        />

        <IconButton
          onClick={handleLogout}
          label="Sign out"
          tone="danger"
        >
          <LogOut className={controlIconClasses.comfortable} />
        </IconButton>
      </div>

      {wsOpen && <NewWorkspaceDialog onClose={() => setWsOpen(false)} />}
    </div>
    </ControlSizeProvider>
  );
}
