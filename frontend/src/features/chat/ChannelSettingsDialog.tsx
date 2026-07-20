import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Bot, Trash2, UserPlus, X, LogOut } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
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
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [savingMeta, setSavingMeta] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InvitableItem[]>([]);
  const [searching, setSearching] = useState(false);

  const myRole = members.find(
    (m) => m.member_type === "user" && m.member_id === me?.user_id
  )?.role;
  const canManage = globalAdmin || myRole === "owner" || myRole === "admin";

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

  async function saveMeta() {
    const trimmed = name.trim();
    if (!trimmed || savingMeta) return;
    setSavingMeta(true);
    try {
      const updated = await updateChannel(channel.channel_id, {
        name: trimmed,
        purpose: purpose.trim() || null,
      });
      patchChannel(channel.channel_id, updated);
      toast.success("Saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingMeta(false);
    }
  }

  async function addMember(it: InvitableItem) {
    try {
      await addChannelMember(channel.channel_id, {
        member_id: it.member_id,
        member_type: it.member_type,
      });
      const who = it.display_name || it.username || it.member_id.slice(0, 8);
      // Users must accept (pending); bots are bound immediately.
      toast.success(it.member_type === "bot" ? `Added ${who}` : `Invited ${who}`);
      setQuery("");
      setResults([]);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add");
    }
  }

  async function removeMember(m: MemberItem) {
    try {
      await removeChannelMember(channel.channel_id, m.member_id);
      await refreshMembers();
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
          <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            Name
          </label>
          <input
            value={name}
            disabled={!canManage}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          />
          <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            Purpose
          </label>
          <input
            value={purpose}
            disabled={!canManage}
            placeholder="(Optional) what this channel is for…"
            onChange={(e) => setPurpose(e.target.value)}
            className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          />
          {canManage && (
            <div className="flex justify-end">
              <Button size="sm" loading={savingMeta} onClick={() => void saveMeta()}>
                Save
              </Button>
            </div>
          )}
        </div>

        {/* Members */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            Members ({members.length})
          </label>
          <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
            {members.map((m) => (
              <div key={m.member_id} className="flex items-center gap-2 rounded-lg bg-zinc-950/40 px-3 py-2.5">
                <span className="relative flex-shrink-0">
                  <Avatar
                    name={m.display_name || m.username}
                    src={m.avatar_url}
                    id={m.member_id}
                    size="sm"
                  />
                  {/* Presence dot: online=green; offline BOT=gray; null → nothing. */}
                  {(m.is_online === true ||
                    (m.is_online === false && m.member_type === "bot")) && (
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-zinc-900 ${
                        m.is_online ? "bg-emerald-500" : "bg-zinc-600"
                      }`}
                    />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className="text-sm text-zinc-200 truncate"
                    title={!m.display_name && !m.username ? m.member_id : undefined}
                  >
                    {m.display_name || m.username || m.member_id.slice(0, 8)}
                    {m.member_type === "bot" && (
                      <span className="ml-1.5 text-[10px] text-indigo-400">BOT</span>
                    )}
                    {m.status === "pending" && (
                      <span className="ml-1.5 text-[10px] text-amber-400/90">
                        Pending
                      </span>
                    )}
                  </p>
                  {canManage &&
                  m.status !== "pending" &&
                  (m.member_type === "user" || m.member_type === "bot") &&
                  m.member_id !== me?.user_id ? (
                    <select
                      value={m.role ?? "member"}
                      onChange={(e) => void changeRole(m, e.target.value)}
                      className="mt-0.5 bg-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {(m.member_type === "bot" ? BOT_ROLES : CHANNEL_ROLES).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r] ?? r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-[11px] text-zinc-400">
                      {ROLE_LABELS[m.role ?? "member"] ?? m.role ?? "member"}
                    </p>
                  )}
                </div>
                {canManage && m.member_id !== me?.user_id && m.role !== "owner" && (
                  <button
                    onClick={() => void removeMember(m)}
                    title="Remove member"
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

          {canManage && (
            <div className="relative">
              <div className="flex items-center gap-2 rounded-lg bg-zinc-950 px-3 py-2 focus-within:ring-2 focus-within:ring-indigo-500 transition-shadow">
                <UserPlus className="w-4 h-4 text-zinc-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Invite workspace members or bots…"
                  className="flex-1 bg-transparent text-sm text-zinc-200 outline-none"
                />
              </div>
              {(results.length > 0 || searching) && (
                <div className="absolute z-10 mt-1 w-full rounded-lg bg-zinc-900 shadow-xl shadow-black/40 max-h-44 overflow-y-auto">
                  {searching && (
                    <div className="px-3 py-2 text-xs text-zinc-400">Searching…</div>
                  )}
                  {results.map((it) => (
                    <button
                      key={`${it.member_type}:${it.member_id}`}
                      disabled={it.already_member}
                      onClick={() => void addMember(it)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left enabled:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-default"
                    >
                      <Avatar
                        name={it.display_name || it.username}
                        src={it.avatar_url}
                        id={it.member_id}
                        size="sm"
                      />
                      {it.member_type === "bot" && (
                        <Bot className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                      )}
                      <span
                        className="text-sm text-zinc-200 truncate"
                        title={!it.display_name && !it.username ? it.member_id : undefined}
                      >
                        {it.display_name || it.username || it.member_id.slice(0, 8)}
                        {it.member_type === "bot" && (
                          <span className="ml-1.5 text-[10px] text-indigo-400">BOT</span>
                        )}
                      </span>
                      {it.already_member ? (
                        <span className="ml-auto text-xs text-zinc-400">Already in</span>
                      ) : (
                        it.username && (
                          <span className="ml-auto text-xs text-zinc-400">@{it.username}</span>
                        )
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {canManage && (
          <TaskClaimSettings
            channelId={channel.channel_id}
            bots={members.filter((m) => m.member_type === "bot" && m.status !== "pending")}
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
            <div>
              <p className="text-sm font-medium text-zinc-200">Delete channel</p>
              <p className="text-xs text-zinc-400 mt-0.5">Deletes its messages and members too. This cannot be undone.</p>
            </div>
            {confirmingDelete ? (
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  variant="secondary"
                  size="sm"
                  autoFocus
                  disabled={deleting}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </Button>
                <Button variant="danger" size="sm" loading={deleting} onClick={() => void doDelete()}>
                  Delete channel
                </Button>
              </div>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirmingDelete(true)}>
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </Button>
            )}
          </div>
        )}

        {/* Leave — only for actual members (the backend blocks the last owner).
            myRole is undefined for a global admin viewing a channel they're not in. */}
        {myRole && (
          <div className="pt-2 border-t border-zinc-800 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-zinc-200">Leave channel</p>
              <p className="text-xs text-zinc-400 mt-0.5">Remove yourself from this channel.</p>
            </div>
            {confirmingLeave ? (
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button variant="ghost" size="sm" autoFocus onClick={() => setConfirmingLeave(false)}>
                  Cancel
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void leave()}>
                  Leave channel
                </Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setConfirmingLeave(true)}>
                <LogOut className="w-3.5 h-3.5" />
                Leave
              </Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
