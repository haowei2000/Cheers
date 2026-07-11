import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Trash2, UserPlus, X, LogOut } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import {
  listWorkspaceMembers,
  inviteWorkspaceMember,
  removeWorkspaceMember,
  searchWorkspaceInvitable,
  updateWorkspace,
  deleteWorkspace,
  setWorkspaceMemberRole,
  leaveWorkspace,
  type WorkspaceInvitable,
  type WorkspaceMember,
} from "@/api/workspaces";
import { useChatStore } from "@/stores/chatStore";
import { useAuthStore } from "@/stores/authStore";
import { InviteLinksSection } from "./InviteLinksSection";
import type { Workspace } from "@/types";

const ROLES = ["member", "admin", "owner"] as const;

// Workspace admin panel: rename, member management (add active / invite pending /
// remove + roles), and delete. Listing members is admin-gated server-side, so a
// successful members load is what unlocks the management controls.
export function WorkspaceSettingsDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const me = useAuthStore((s) => s.user);
  const workspaces = useChatStore((s) => s.workspaces);
  const setWorkspaces = useChatStore((s) => s.setWorkspaces);
  const selectWorkspace = useChatStore((s) => s.selectWorkspace);
  const personalWorkspace = useChatStore((s) => s.personalWorkspace);

  const [name, setName] = useState(workspace.name);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);

  const [query, setQuery] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("member");
  const [results, setResults] = useState<WorkspaceInvitable[]>([]);
  const [searching, setSearching] = useState(false);

  // In-app confirmation for destructive actions (remove member / delete / leave) —
  // replaces native confirm(), whose OK is the reflexive Enter default. Initial focus
  // lands on the dialog's Close (X) button, so a reflexive Enter dismisses rather than
  // firing the destructive action; the destructive button is never the keyboard default.
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  async function refreshMembers() {
    try {
      setMembers(await listWorkspaceMembers(workspace.workspace_id));
      setCanManage(true);
    } catch {
      setCanManage(false);
    }
  }

  useEffect(() => {
    void refreshMembers();
  }, [workspace.workspace_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Candidate search: friends by substring, anyone by exact username/email — the
  // dedicated workspace endpoint. (The old code hit /friends/search, which only
  // matches an exact UUID, so typing a name always found nobody.)
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      searchWorkspaceInvitable(workspace.workspace_id, q)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query, workspace.workspace_id]);

  async function saveMeta() {
    const trimmed = name.trim();
    if (!trimmed || savingMeta) return;
    setSavingMeta(true);
    try {
      const updated = await updateWorkspace(workspace.workspace_id, { name: trimmed });
      setWorkspaces(
        workspaces.map((w) => (w.workspace_id === workspace.workspace_id ? { ...w, ...updated } : w))
      );
      toast.success("Saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingMeta(false);
    }
  }

  // Every membership requires the invitee's consent — there is no consent-free
  // "add directly" path anymore. This sends a pending invite they must accept.
  async function invite(u: WorkspaceInvitable) {
    try {
      const res = await inviteWorkspaceMember(workspace.workspace_id, {
        identifier: u.user_id,
        role,
      });
      toast.success(res.status === "exists" ? "Already a member" : "Invite sent");
      setQuery("");
      setResults([]);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Operation failed");
    }
  }

  async function removeMember(m: WorkspaceMember) {
    try {
      await removeWorkspaceMember(workspace.workspace_id, m.user_id);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove");
    }
  }

  async function doDelete() {
    try {
      await deleteWorkspace(workspace.workspace_id);
      setWorkspaces(workspaces.filter((w) => w.workspace_id !== workspace.workspace_id));
      selectWorkspace(personalWorkspace?.workspace_id ?? null);
      toast.success("Workspace deleted");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  async function changeRole(m: WorkspaceMember, role: string) {
    try {
      await setWorkspaceMemberRole(workspace.workspace_id, m.user_id, role);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to change role");
    }
  }

  async function leave() {
    try {
      await leaveWorkspace(workspace.workspace_id);
      setWorkspaces(workspaces.filter((w) => w.workspace_id !== workspace.workspace_id));
      selectWorkspace(personalWorkspace?.workspace_id ?? null);
      toast.success("Left workspace");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to leave");
    }
  }

  return (
    <>
    <Dialog title={`Workspace settings · ${workspace.name}`} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-5">
        {!canManage && (
          <p className="text-xs text-amber-400/80 bg-amber-950/30 rounded-lg px-3 py-2">
            You are not an admin of this workspace, so you can only view its name.
          </p>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Name</label>
          <div className="flex gap-2">
            <input
              value={name}
              disabled={!canManage}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            />
            {canManage && (
              <Button size="sm" loading={savingMeta} onClick={() => void saveMeta()}>
                Save
              </Button>
            )}
          </div>
        </div>

        {canManage && (
          <>
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                Members ({members.length})
              </label>
              <div className="max-h-48 overflow-y-auto rounded-lg bg-zinc-950/40 divide-y divide-zinc-800/60">
                {members.map((m) => (
                  <div key={m.user_id} className="flex items-center gap-2 px-3 py-2">
                    <Avatar name={m.display_name || m.username} id={m.user_id} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-200 truncate">
                        {m.display_name || m.username}
                        {m.status === "pending" && (
                          <span className="ml-1.5 text-[10px] text-amber-400">Pending</span>
                        )}
                      </p>
                      {m.user_id !== me?.user_id ? (
                        <select
                          value={m.role}
                          onChange={(e) => void changeRole(m, e.target.value)}
                          className="mt-0.5 bg-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-[11px] text-zinc-400">{m.role}</p>
                      )}
                    </div>
                    {m.user_id !== me?.user_id && m.role !== "owner" && (
                      <button
                        onClick={() =>
                          setConfirmState({
                            title: "Remove member",
                            message: `Remove ${m.display_name || m.username} from this workspace? They must accept a new invite to rejoin.`,
                            confirmLabel: "Remove",
                            onConfirm: () => removeMember(m),
                          })
                        }
                        title={`Remove ${m.display_name || m.username}`}
                        aria-label={`Remove ${m.display_name || m.username}`}
                        className="text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded p-1"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
                {members.length === 0 && (
                  <div className="px-3 py-4 text-xs text-zinc-400 text-center">No members yet</div>
                )}
              </div>

              <div className="relative">
                <div className="flex items-center gap-2 rounded-lg bg-zinc-950 px-3 py-2 focus-within:ring-2 focus-within:ring-indigo-500 transition-shadow">
                  <UserPlus className="w-4 h-4 text-zinc-500" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search friends, or exact username / email…"
                    className="flex-1 bg-transparent text-sm text-zinc-200 outline-none"
                  />
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
                    className="bg-zinc-800 rounded px-1.5 py-1 text-xs text-zinc-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                {(results.length > 0 || searching || query.trim().length >= 2) && (
                  <div className="absolute z-10 mt-1 w-full rounded-lg bg-zinc-900 shadow-xl shadow-black/40 max-h-44 overflow-y-auto">
                    {searching && (
                      <div className="px-3 py-2 text-xs text-zinc-400">Searching…</div>
                    )}
                    {results.map((u) => (
                      <div
                        key={u.user_id}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-800"
                      >
                        <Avatar name={u.display_name || u.username} id={u.user_id} size="sm" />
                        <span className="text-sm text-zinc-200 truncate flex-1">
                          {u.display_name || u.username}
                        </span>
                        {u.membership ? (
                          <span className="text-[10px] text-zinc-400 rounded px-1 py-0.5">
                            {u.membership === "pending" ? "Invited" : "Member"}
                          </span>
                        ) : (
                          <button
                            onClick={() => void invite(u)}
                            title="Send an invite the user must accept"
                            className="text-xs text-indigo-400 hover:text-indigo-300"
                          >
                            Invite
                          </button>
                        )}
                      </div>
                    ))}
                    {!searching && results.length === 0 && query.trim().length >= 2 && (
                      <div className="px-3 py-2 text-xs text-zinc-400">
                        No matches. Name search covers your friends — for anyone else,
                        type their exact username or email.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <InviteLinksSection workspaceId={workspace.workspace_id} />

            <div className="pt-2 border-t border-zinc-800 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-200">Delete workspace</p>
                <p className="text-xs text-zinc-400 mt-0.5">Deletes its channels too. This cannot be undone.</p>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={() =>
                  setConfirmState({
                    title: "Delete workspace",
                    message: `Delete "${workspace.name}"? Its channels are deleted too. This cannot be undone.`,
                    confirmLabel: "Delete",
                    onConfirm: doDelete,
                  })
                }
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </Button>
            </div>
          </>
        )}

        {/* Leave — only for actual members (the backend blocks the last owner).
            Non-admins can't list members but reached this from their own workspace,
            so they're members; a global admin viewing a workspace they're not in has
            the member list loaded without themselves in it → hide. */}
        {(!canManage || members.some((m) => m.user_id === me?.user_id)) && (
          <div className="pt-2 border-t border-zinc-800 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-200">Leave workspace</p>
              <p className="text-xs text-zinc-400 mt-0.5">Remove yourself from this workspace.</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setConfirmState({
                  title: "Leave workspace",
                  message: `Leave "${workspace.name}"? You'll need a new invite to rejoin.`,
                  confirmLabel: "Leave",
                  onConfirm: leave,
                })
              }
            >
              <LogOut className="w-3.5 h-3.5" />
              Leave
            </Button>
          </div>
        )}
      </div>
    </Dialog>

    {confirmState && (
      <Dialog
        title={confirmState.title}
        onClose={() => {
          if (!confirmBusy) setConfirmState(null);
        }}
        maxWidth="max-w-sm"
      >
        <p className="text-sm text-zinc-300">{confirmState.message}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            disabled={confirmBusy}
            onClick={() => setConfirmState(null)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={confirmBusy}
            onClick={async () => {
              setConfirmBusy(true);
              try {
                await confirmState.onConfirm();
                setConfirmState(null);
              } finally {
                setConfirmBusy(false);
              }
            }}
          >
            {confirmState.confirmLabel}
          </Button>
        </div>
      </Dialog>
    )}
    </>
  );
}
