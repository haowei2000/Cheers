import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Trash2, LogOut } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { EntityItem, OperationsItem } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { controlIconClasses } from "@/components/ui/control-size";
import {
  CollectionDeleteItem,
  CollectionEmptyItem,
  CollectionManager,
  CollectionPickerItem,
  type CollectionMode,
} from "@/components/ui/collection-manager";
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
  const [memberQuery, setMemberQuery] = useState("");
  const [memberMode, setMemberMode] = useState<CollectionMode>({ kind: "browse" });
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
  const visibleMembers = useMemo(() => {
    const normalized = memberQuery.trim().toLocaleLowerCase();
    if (!normalized) return members;
    return members.filter((member) => (
      `${member.display_name ?? ""} ${member.username ?? ""} ${member.role} ${member.status}`
        .toLocaleLowerCase()
        .includes(normalized)
    ));
  }, [memberQuery, members]);

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
      setMemberMode({ kind: "browse" });
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Operation failed");
    }
  }

  async function removeMember(m: WorkspaceMember) {
    try {
      await removeWorkspaceMember(workspace.workspace_id, m.user_id);
      await refreshMembers();
      setMemberMode({ kind: "browse" });
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
          <p className="text-compact text-amber-400/80 bg-amber-950/30 rounded-sm px-3 py-2">
            You are not an admin of this workspace, so you can only view its name.
          </p>
        )}

        <div className="space-y-2">
          <label className="text-compact font-medium text-zinc-400 uppercase tracking-wide">Name</label>
          <div className="flex gap-2">
            <UiInput
              value={name}
              disabled={!canManage}
              onChange={(e) => setName(e.target.value)}
              controlSize="regular" className="flex-1 rounded-sm bg-zinc-800 text-regular text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            />
            {canManage && (
              <Button controlSize="compact" loading={savingMeta} onClick={() => void saveMeta()}>
                Save
              </Button>
            )}
          </div>
        </div>

        {canManage && (
          <>
            <CollectionManager
              label="Members"
              count={members.length}
              query={memberQuery}
              onQueryChange={setMemberQuery}
              searchPlaceholder="Search members"
              addLabel="Add member"
              onAdd={() => {
                setQuery("");
                setResults([]);
                setRole("member");
                setMemberMode({ kind: "add" });
              }}
              addDisabled={memberMode.kind !== "browse"}
              presentationLevel="medium"
              controlSize="regular"
              className="border-t border-zinc-800 pt-3"
            >
              {memberMode.kind === "add" && (
                <CollectionPickerItem
                  title="Invite workspace member"
                  query={query}
                  onQueryChange={setQuery}
                  placeholder="Search friends, username, or email…"
                  onCancel={() => setMemberMode({ kind: "browse" })}
                >
                  <OperationsItem
                    title="Invite role"
                    trailing={(
                      <UiSelect
                        aria-label="Role for new workspace member"
                        value={role}
                        onChange={(event) => setRole(event.target.value as (typeof ROLES)[number])}
                        controlSize="compact"
                      >
                        {ROLES.map((candidateRole) => (
                          <option key={candidateRole} value={candidateRole}>{candidateRole}</option>
                        ))}
                      </UiSelect>
                    )}
                  />
                  {searching && <OperationsItem title="Searching…" />}
                  {!searching && query.trim().length < 2 && <OperationsItem title="Type at least 2 characters" />}
                  {!searching && query.trim().length >= 2 && results.length === 0 && <OperationsItem title="No matching members" />}
                  {!searching && results.map((candidate) => (
                    <EntityItem
                      key={candidate.user_id}
                      disabled={Boolean(candidate.membership)}
                      onClick={() => void invite(candidate)}
                      title={candidate.display_name || candidate.username}
                      leading={<Avatar name={candidate.display_name || candidate.username} id={candidate.user_id} size="regular" />}
                      status={candidate.membership ? (
                        <span className="font-utility text-compact uppercase text-zinc-500">
                          {candidate.membership === "pending" ? "Invited" : "Member"}
                        </span>
                      ) : undefined}
                    />
                  ))}
                </CollectionPickerItem>
              )}

              {visibleMembers.map((member) => {
                if (memberMode.kind === "delete" && memberMode.id === member.user_id) {
                  return (
                    <CollectionDeleteItem
                      key={member.user_id}
                      title={`Remove ${member.display_name || member.username}?`}
                      description="They must accept a new invite to rejoin."
                      onCancel={() => setMemberMode({ kind: "browse" })}
                      onConfirm={() => void removeMember(member)}
                    />
                  );
                }
                const isSelf = member.user_id === me?.user_id;
                const removable = !isSelf && member.role !== "owner";
                return (
                  <EntityItem
                    key={member.user_id}
                    title={member.display_name || member.username}
                    leading={<Avatar name={member.display_name || member.username} id={member.user_id} size="regular" />}
                    status={isSelf ? <span className="font-utility text-compact uppercase text-zinc-500">{member.role}</span> : undefined}
                    criticalStatus={member.status === "pending" ? <span className="font-utility text-compact uppercase text-amber-400">Pending</span> : undefined}
                    actions={!isSelf ? (
                      <>
                        <UiSelect
                          aria-label={`Role for ${member.display_name || member.username}`}
                          value={member.role}
                          onChange={(event) => void changeRole(member, event.target.value)}
                          controlSize="compact"
                        >
                          {ROLES.map((candidateRole) => (
                            <option key={candidateRole} value={candidateRole}>{candidateRole}</option>
                          ))}
                        </UiSelect>
                        {removable && (
                          <IconButton
                            label={`Remove ${member.display_name || member.username}`}
                            tone="danger"
                            controlSize="compact"
                            onClick={() => setMemberMode({ kind: "delete", id: member.user_id })}
                          >
                            <Trash2 className={controlIconClasses.compact} />
                          </IconButton>
                        )}
                      </>
                    ) : undefined}
                  />
                );
              })}

              {visibleMembers.length === 0 && memberMode.kind !== "add" && (
                <CollectionEmptyItem query={memberQuery} onClear={() => setMemberQuery("")} />
              )}
            </CollectionManager>

            <InviteLinksSection workspaceId={workspace.workspace_id} />

            <div className="pt-2 border-t border-zinc-800 flex items-center justify-between">
              <div>
                <p className="text-regular font-medium text-zinc-200">Delete workspace</p>
                <p className="text-compact text-zinc-400 mt-0.5">Deletes its channels too. This cannot be undone.</p>
              </div>
              <Button
                variant="danger"
                controlSize="compact"
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
              <p className="text-regular font-medium text-zinc-200">Leave workspace</p>
              <p className="text-compact text-zinc-400 mt-0.5">Remove yourself from this workspace.</p>
            </div>
            <Button
              variant="secondary"
              controlSize="compact"
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
        <p className="text-regular text-zinc-300">{confirmState.message}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="secondary"
            controlSize="compact"
            disabled={confirmBusy}
            onClick={() => setConfirmState(null)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            controlSize="compact"
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
