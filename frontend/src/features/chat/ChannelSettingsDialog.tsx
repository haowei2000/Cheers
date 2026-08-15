import { Button as UiButton } from "@/components/ui/button";
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
import { InlineEditActions } from "@/components/ui/inline-edit-actions";
import { controlIconClasses } from "@/components/ui/control-size";
import {
  CollectionDeleteItem,
  CollectionEmptyItem,
  CollectionManager,
  CollectionPickerItem,
  type CollectionMode,
} from "@/components/ui/collection-manager";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { uploadChannelAvatar } from "@/api/avatars";
import {
  listChannelMembers,
  addChannelMember,
  removeChannelMember,
  updateChannel,
  deleteChannel,
  leaveChannel,
  setChannelMemberRole,
  searchInvitable,
  type InvitableItem,
} from "@/api/channels";

const CHANNEL_ROLES = ["owner", "admin", "member", "readonly"] as const;
// Bots can never own/administer a channel — the backend rejects those roles.
const BOT_ROLES = ["member", "readonly"] as const;
// Human labels for the raw role constants — the wire value stays raw, only the
// visible option text changes.
const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  readonly: "Read-only",
};
import { useChatStore } from "@/stores/chatStore";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import { InviteLinksSection } from "./InviteLinksSection";
import type { Channel, MemberItem } from "@/types";
import { TaskClaimSettings } from "./TaskClaimSettings";
import {
  ConversationModePicker,
  type ConversationMode,
} from "./ConversationModePicker";

// Channel admin panel: rename/purpose, member list (add/remove members — users
// AND bots, invited alike), and delete. Management controls are gated on the
// caller being an owner/admin of the channel (or a global admin); the backend
// enforces the same.
export function ChannelSettingsDialog({
  channel,
  onClose,
}: {
  channel: Channel;
  onClose: () => void;
}) {
  const me = useAuthStore((s) => s.user);
  const globalAdmin = useIsAdmin();
  const patchChannel = useChatStore((s) => s.patchChannel);
  const channels = useChatStore((s) => s.channels);
  const setChannels = useChatStore((s) => s.setChannels);
  const selectChannel = useChatStore((s) => s.selectChannel);

  const [name, setName] = useState(channel.name);
  const [purpose, setPurpose] = useState(channel.purpose ?? "");
  const [conversationMode, setConversationMode] = useState<ConversationMode>(
    channel.conversation_mode ?? "chat",
  );
  const [savedMeta, setSavedMeta] = useState({
    name: channel.name,
    purpose: channel.purpose ?? "",
    conversationMode: channel.conversation_mode ?? "chat" as ConversationMode,
  });
  const [editingMeta, setEditingMeta] = useState<"name" | "purpose" | "layout" | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [savingMeta, setSavingMeta] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const [query, setQuery] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberMode, setMemberMode] = useState<CollectionMode>({ kind: "browse" });
  const [results, setResults] = useState<InvitableItem[]>([]);
  const [searching, setSearching] = useState(false);

  const myRole = members.find(
    (m) => m.member_type === "user" && m.member_id === me?.user_id
  )?.role;
  const canManage = globalAdmin || myRole === "owner" || myRole === "admin";
  const visibleMembers = useMemo(() => {
    const normalized = memberQuery.trim().toLocaleLowerCase();
    if (!normalized) return members;
    return members.filter((member) => (
      `${member.display_name ?? ""} ${member.username ?? ""} ${member.role ?? ""} ${member.member_type}`
        .toLocaleLowerCase()
        .includes(normalized)
    ));
  }, [memberQuery, members]);

  async function refreshMembers() {
    try {
      setMembers(await listChannelMembers(channel.channel_id));
    } catch {
      /* not a member / no access */
    }
  }

  useEffect(() => {
    void refreshMembers();
  }, [channel.channel_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const next = {
      name: channel.name,
      purpose: channel.purpose ?? "",
      conversationMode: channel.conversation_mode ?? "chat" as ConversationMode,
    };
    setSavedMeta(next);
    setName(next.name);
    setPurpose(next.purpose);
    setConversationMode(next.conversationMode);
    setEditingMeta(null);
  }, [channel.channel_id, channel.name, channel.purpose, channel.conversation_mode]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      searchInvitable(channel.channel_id, q)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query, channel.channel_id]);

  function resetMetaDrafts() {
    setName(savedMeta.name);
    setPurpose(savedMeta.purpose);
    setConversationMode(savedMeta.conversationMode);
  }

  function beginMetaEdit(field: "name" | "purpose" | "layout") {
    resetMetaDrafts();
    setEditingMeta(field);
  }

  function cancelMetaEdit() {
    resetMetaDrafts();
    setEditingMeta(null);
  }

  async function saveMeta() {
    const trimmed = name.trim();
    if (!trimmed || savingMeta) return;
    setSavingMeta(true);
    try {
      const updated = await updateChannel(channel.channel_id, {
        name: trimmed,
        purpose: purpose.trim() || null,
        conversation_mode: conversationMode,
      });
      patchChannel(channel.channel_id, updated);
      setSavedMeta({ name: trimmed, purpose: purpose.trim(), conversationMode });
      setEditingMeta(null);
      toast.success("Saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingMeta(false);
    }
  }

  async function uploadAvatar(file: File) {
    const avatar_url = await uploadChannelAvatar(channel.channel_id, file);
    patchChannel(channel.channel_id, { avatar_url });
    return avatar_url;
  }

  async function addMember(it: InvitableItem) {
    try {
      const result = await addChannelMember(channel.channel_id, {
        member_id: it.member_id,
        member_type: it.member_type,
      });
      const who = it.display_name || it.username || it.member_id.slice(0, 8);
      const message = {
        active: `Added ${who}`,
        pending: `Invited ${who}`,
        pending_workspace: `Invited ${who} to the workspace first`,
        pending_owner: `Sent ${who}'s owner an approval request`,
      }[result.status];
      toast.success(message);
      setQuery("");
      setResults([]);
      setMemberMode({ kind: "browse" });
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add");
    }
  }

  async function removeMember(m: MemberItem) {
    try {
      await removeChannelMember(channel.channel_id, m.member_id);
      await refreshMembers();
      setMemberMode({ kind: "browse" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove");
    }
  }

  async function doDelete() {
    setDeleting(true);
    try {
      await deleteChannel(channel.channel_id);
      setChannels(channels.filter((c) => c.channel_id !== channel.channel_id));
      selectChannel(null);
      toast.success("Channel deleted");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
    }
  }

  async function changeRole(m: MemberItem, role: string) {
    try {
      await setChannelMemberRole(channel.channel_id, m.member_id, role);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to change role");
    }
  }

  async function leave() {
    try {
      await leaveChannel(channel.channel_id);
      setChannels(channels.filter((c) => c.channel_id !== channel.channel_id));
      selectChannel(null);
      toast.success("Left channel");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to leave");
    }
  }

  return (
    <Dialog title={`Channel settings · ${channel.name}`} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-5">
        {/* Meta */}
        <div className="space-y-2">
          {channel.type !== "dm" && canManage && (
            <div className="flex items-center gap-3 pb-2">
              <AvatarUpload
                name={channel.name}
                id={channel.channel_id}
                src={channel.avatar_url}
                onUpload={uploadAvatar}
              />
              <span className="text-regular text-content-muted">Channel avatar</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label htmlFor="channel-settings-name" className="min-w-0 flex-1 text-compact font-medium text-content-muted uppercase tracking-label">
              Name
            </label>
            {canManage && (
              <InlineEditActions
                label="channel name"
                editing={editingMeta === "name"}
                saving={savingMeta}
                disabled={!name.trim()}
                onEdit={() => beginMetaEdit("name")}
                onSave={() => void saveMeta()}
                onCancel={cancelMetaEdit}
              />
            )}
          </div>
          {editingMeta === "name" ? (
            <UiInput
              id="channel-settings-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-content-secondary focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          ) : (
            <p className="flex min-h-9 min-w-0 items-center rounded-sm bg-zinc-900/60 px-3 font-utility text-regular text-content-secondary">
              <span className="truncate">{savedMeta.name}</span>
            </p>
          )}
          {channel.type !== "dm" && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-compact font-medium uppercase tracking-label text-content-muted">
                  Conversation layout
                </span>
                {canManage && (
                  <InlineEditActions
                    label="conversation layout"
                    editing={editingMeta === "layout"}
                    saving={savingMeta}
                    onEdit={() => beginMetaEdit("layout")}
                    onSave={() => void saveMeta()}
                    onCancel={cancelMetaEdit}
                  />
                )}
              </div>
              <ConversationModePicker
                value={conversationMode}
                onChange={setConversationMode}
                disabled={editingMeta !== "layout"}
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <label htmlFor="channel-settings-purpose" className="min-w-0 flex-1 text-compact font-medium text-content-muted uppercase tracking-label">
              Purpose
            </label>
            {canManage && (
              <InlineEditActions
                label="channel purpose"
                editing={editingMeta === "purpose"}
                saving={savingMeta}
                onEdit={() => beginMetaEdit("purpose")}
                onSave={() => void saveMeta()}
                onCancel={cancelMetaEdit}
              />
            )}
          </div>
          {editingMeta === "purpose" ? (
            <UiInput
              id="channel-settings-purpose"
              autoFocus
              value={purpose}
              placeholder="(Optional) what this channel is for…"
              onChange={(e) => setPurpose(e.target.value)}
              controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-content-secondary focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          ) : (
            <p className="flex min-h-9 min-w-0 items-center rounded-sm bg-zinc-900/60 px-3 font-utility text-regular text-content-muted">
              <span className="truncate">{savedMeta.purpose || "No purpose set"}</span>
            </p>
          )}
        </div>

        {/* Members use the same browse/add/delete collection anatomy as Claims and Links. */}
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
            setMemberMode({ kind: "add" });
          }}
          showAdd={canManage}
          addDisabled={memberMode.kind !== "browse"}
          presentationLevel="medium"
          controlSize="regular"
          className="border-t border-zinc-800 pt-3"
        >
          {memberMode.kind === "add" && (
            <CollectionPickerItem
              title="Add workspace member or bot"
              query={query}
              onQueryChange={setQuery}
              placeholder="Search workspace members or bots…"
              onCancel={() => setMemberMode({ kind: "browse" })}
            >
              {searching && <OperationsItem title="Searching…" />}
              {!searching && query.trim().length < 2 && (
                <OperationsItem title="Type at least 2 characters" />
              )}
              {!searching && query.trim().length >= 2 && results.length === 0 && (
                <OperationsItem title="No matching members" />
              )}
              {!searching && results.map((it) => (
                <EntityItem
                  key={`${it.member_type}:${it.member_id}`}
                  disabled={it.already_member}
                  onClick={() => void addMember(it)}
                  title={it.display_name || it.username || it.member_id.slice(0, 8)}
                  leading={<Avatar name={it.display_name || it.username} src={it.avatar_url} id={it.member_id} size="regular" />}
                  status={it.member_type === "bot" ? <span className="font-utility text-compact uppercase text-content-muted">Bot</span> : undefined}
                  criticalStatus={it.requires_workspace_acceptance ? <span className="font-utility text-compact uppercase text-warning-400">Workspace first</span> : undefined}
                  trailing={it.already_member ? <span className="font-utility text-compact text-content-muted">Already in</span> : undefined}
                />
              ))}
            </CollectionPickerItem>
          )}

          {visibleMembers.map((m) => {
            if (memberMode.kind === "delete" && memberMode.id === m.member_id) {
              return (
                <CollectionDeleteItem
                  key={m.member_id}
                  title={`Remove ${m.display_name || m.username || "member"}?`}
                  description="They will lose access to this channel."
                  onCancel={() => setMemberMode({ kind: "browse" })}
                  onConfirm={() => void removeMember(m)}
                />
              );
            }
            const canChangeRole = canManage && m.status === "active" && m.member_id !== me?.user_id;
            const canRemove = canManage && m.member_id !== me?.user_id && m.role !== "owner";
            const roleLabel = ROLE_LABELS[m.role ?? "member"] ?? m.role ?? "Member";
            return (
              <EntityItem
                key={m.member_id}
                title={m.display_name || m.username || m.member_id.slice(0, 8)}
                leading={(
                  <Avatar
                    name={m.display_name || m.username}
                    src={m.avatar_url}
                    id={m.member_id}
                    size="regular"
                    online={m.is_online === true ? true : m.is_online === false && m.member_type === "bot" ? false : undefined}
                  />
                )}
                status={!canChangeRole ? (
                  <span className="font-utility text-compact uppercase text-content-muted">
                    {m.member_type === "bot" ? `Bot · ${roleLabel}` : roleLabel}
                  </span>
                ) : m.member_type === "bot" ? (
                  <span className="font-utility text-compact uppercase text-content-muted">Bot</span>
                ) : undefined}
                criticalStatus={m.status && m.status !== "active" ? (
                  <span className="font-utility text-compact uppercase text-warning-400">
                    {m.status === "pending_owner" ? "Waiting for owner" : m.status === "pending_workspace" ? "Waiting for workspace" : "Pending"}
                  </span>
                ) : undefined}
                actions={canChangeRole || canRemove ? (
                  <>
                    {canChangeRole && (
                      <UiSelect
                        aria-label={`Role for ${m.display_name || m.username || "member"}`}
                        value={m.role ?? "member"}
                        onChange={(event) => void changeRole(m, event.target.value)}
                        controlSize="compact"
                      >
                        {(m.member_type === "bot" ? BOT_ROLES : CHANNEL_ROLES).map((role) => (
                          <option key={role} value={role}>{ROLE_LABELS[role] ?? role}</option>
                        ))}
                      </UiSelect>
                    )}
                    {canRemove && (
                      <IconButton
                        label={`Remove ${m.display_name || m.username || "member"}`}
                        tone="danger"
                        controlSize="compact"
                        onClick={() => setMemberMode({ kind: "delete", id: m.member_id })}
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

        {canManage && (
          <TaskClaimSettings
            channelId={channel.channel_id}
            bots={members.filter((m) => m.member_type === "bot" && m.status === "active")}
          />
        )}

        {/* Shareable invite links — public channels only (a link joiner enters the
            workspace + this channel). The section hides itself for non-workspace-
            admins, since links admit people into the whole workspace. */}
        {canManage && channel.type === "public" && channel.workspace_id && (
          <InviteLinksSection
            workspaceId={channel.workspace_id}
            channelId={channel.channel_id}
          />
        )}

        {/* Danger zone — a two-step inline confirm (no native confirm(), whose
            Enter default runs the destructive "OK"). Cancel leads and takes
            focus; the delete action is never the keyboard default. */}
        {canManage && (
          <div className="pt-2 border-t border-zinc-800 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-regular font-medium text-content-secondary">Delete channel</p>
              <p className="text-compact text-content-muted mt-1">Deletes its messages and members too. This cannot be undone.</p>
            </div>
            {confirmingDelete ? (
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  action="cancel"
                  variant="secondary"
                  controlSize="compact"
                  autoFocus
                  disabled={deleting}
                  onClick={() => setConfirmingDelete(false)}
                />
                <Button action="delete" aria-label="Delete channel" variant="danger" controlSize="compact" loading={deleting} onClick={() => void doDelete()} />
              </div>
            ) : (
              <Button content="iconText" action="delete" aria-label="Delete channel" variant="danger" controlSize="compact" className="shrink-0" onClick={() => setConfirmingDelete(true)}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        )}

        {/* Leave — only for actual members (the backend blocks the last owner).
            myRole is undefined for a global admin viewing a channel they're not in. */}
        {myRole && (
          <div className="pt-2 border-t border-zinc-800 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-regular font-medium text-content-secondary">Leave channel</p>
              <p className="text-compact text-content-muted mt-1">Remove yourself from this channel.</p>
            </div>
            {confirmingLeave ? (
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button action="cancel" variant="ghost" controlSize="compact" autoFocus onClick={() => setConfirmingLeave(false)} />
                <Button action="leave" aria-label="Leave channel" variant="secondary" controlSize="compact" onClick={() => void leave()} />
              </div>
            ) : (
              <Button content="iconText" action="leave" aria-label="Leave channel" variant="secondary" controlSize="compact" className="shrink-0" onClick={() => setConfirmingLeave(true)}>
                <LogOut className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
