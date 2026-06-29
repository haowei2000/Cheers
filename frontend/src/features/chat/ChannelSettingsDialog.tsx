import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Trash2, UserPlus, X, LogOut } from "lucide-react";
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
} from "@/api/channels";

const CHANNEL_ROLES = ["owner", "admin", "member", "readonly"] as const;
import { searchUsers, type UserSearchResult } from "@/api/users";
import { useChatStore } from "@/stores/chatStore";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import type { Channel, MemberItem } from "@/types";

// Channel admin panel: rename/purpose, member list (add/remove human members),
// and delete. Management controls are gated on the caller being an owner/admin of
// the channel (or a global admin); the backend enforces the same.
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

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[]>([]);
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
      searchUsers(q)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

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
      toast.success("已保存");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingMeta(false);
    }
  }

  async function addMember(u: UserSearchResult) {
    try {
      await addChannelMember(channel.channel_id, {
        member_id: u.user_id,
        member_type: "user",
      });
      toast.success(`已添加 ${u.display_name || u.username}`);
      setQuery("");
      setResults([]);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "添加失败");
    }
  }

  async function removeMember(m: MemberItem) {
    try {
      await removeChannelMember(channel.channel_id, m.member_id);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "移除失败");
    }
  }

  async function doDelete() {
    if (!confirm(`删除频道「${channel.name}」？此操作不可撤销。`)) return;
    try {
      await deleteChannel(channel.channel_id);
      setChannels(channels.filter((c) => c.channel_id !== channel.channel_id));
      selectChannel(null);
      toast.success("频道已删除");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    }
  }

  async function changeRole(m: MemberItem, role: string) {
    try {
      await setChannelMemberRole(channel.channel_id, m.member_id, role);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "改角色失败");
    }
  }

  async function leave() {
    if (!confirm(`退出频道「${channel.name}」？`)) return;
    try {
      await leaveChannel(channel.channel_id);
      setChannels(channels.filter((c) => c.channel_id !== channel.channel_id));
      selectChannel(null);
      toast.success("已退出频道");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "退出失败");
    }
  }

  return (
    <Dialog title={`频道设置 · ${channel.name}`} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-5">
        {/* Meta */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
            名称
          </label>
          <input
            value={name}
            disabled={!canManage}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500 disabled:opacity-60"
          />
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
            主题
          </label>
          <input
            value={purpose}
            disabled={!canManage}
            placeholder="（可选）频道用途…"
            onChange={(e) => setPurpose(e.target.value)}
            className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500 disabled:opacity-60"
          />
          {canManage && (
            <div className="flex justify-end">
              <Button size="sm" loading={savingMeta} onClick={() => void saveMeta()}>
                保存
              </Button>
            </div>
          )}
        </div>

        {/* Members */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
            成员 ({members.length})
          </label>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-800 divide-y divide-zinc-800/60">
            {members.map((m) => (
              <div key={m.member_id} className="flex items-center gap-2 px-3 py-2">
                <Avatar name={m.display_name || m.username} id={m.member_id} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-200 truncate">
                    {m.display_name || m.username || m.member_id.slice(0, 8)}
                    {m.member_type === "bot" && (
                      <span className="ml-1.5 text-[10px] text-indigo-400">BOT</span>
                    )}
                  </p>
                  {canManage && m.member_type === "user" && m.member_id !== me?.user_id ? (
                    <select
                      value={m.role ?? "member"}
                      onChange={(e) => void changeRole(m, e.target.value)}
                      className="mt-0.5 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300 outline-none"
                    >
                      {CHANNEL_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-[11px] text-zinc-500">{m.role ?? "member"}</p>
                  )}
                </div>
                {canManage && m.member_id !== me?.user_id && m.role !== "owner" && (
                  <button
                    onClick={() => void removeMember(m)}
                    title="移除"
                    className="text-zinc-500 hover:text-red-400 p-1"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
            {members.length === 0 && (
              <div className="px-3 py-4 text-xs text-zinc-600 text-center">暂无成员</div>
            )}
          </div>

          {canManage && (
            <div className="relative">
              <div className="flex items-center gap-2 rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2">
                <UserPlus className="w-4 h-4 text-zinc-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索用户名添加成员…"
                  className="flex-1 bg-transparent text-sm text-zinc-200 outline-none"
                />
              </div>
              {(results.length > 0 || searching) && (
                <div className="absolute z-10 mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 shadow-lg max-h-44 overflow-y-auto">
                  {searching && (
                    <div className="px-3 py-2 text-xs text-zinc-500">搜索中…</div>
                  )}
                  {results.map((u) => (
                    <button
                      key={u.user_id}
                      onClick={() => void addMember(u)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 text-left"
                    >
                      <Avatar name={u.display_name || u.username} id={u.user_id} size="sm" />
                      <span className="text-sm text-zinc-200 truncate">
                        {u.display_name || u.username}
                      </span>
                      <span className="ml-auto text-xs text-zinc-500">@{u.username}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Danger zone */}
        {canManage && (
          <div className="pt-2 border-t border-zinc-800 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-200">删除频道</p>
              <p className="text-xs text-zinc-500 mt-0.5">连同消息、成员一并删除，不可撤销。</p>
            </div>
            <Button variant="danger" size="sm" onClick={() => void doDelete()}>
              <Trash2 className="w-3.5 h-3.5" />
              删除
            </Button>
          </div>
        )}

        {/* Leave — available to any member (the backend blocks the last owner). */}
        <div className="pt-2 border-t border-zinc-800 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-200">退出频道</p>
            <p className="text-xs text-zinc-500 mt-0.5">把自己移出该频道。</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void leave()}>
            <LogOut className="w-3.5 h-3.5" />
            退出
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
