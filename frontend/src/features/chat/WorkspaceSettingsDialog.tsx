import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Trash2, UserPlus, X, LogOut } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import {
  listWorkspaceMembers,
  addWorkspaceMember,
  inviteWorkspaceMember,
  removeWorkspaceMember,
  updateWorkspace,
  deleteWorkspace,
  setWorkspaceMemberRole,
  leaveWorkspace,
  type WorkspaceMember,
} from "@/api/workspaces";
import { searchUsers, type UserSearchResult } from "@/api/users";
import { useChatStore } from "@/stores/chatStore";
import { useAuthStore } from "@/stores/authStore";
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
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

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
      const updated = await updateWorkspace(workspace.workspace_id, { name: trimmed });
      setWorkspaces(
        workspaces.map((w) => (w.workspace_id === workspace.workspace_id ? { ...w, ...updated } : w))
      );
      toast.success("已保存");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingMeta(false);
    }
  }

  async function add(u: UserSearchResult, invite: boolean) {
    try {
      if (invite) {
        const res = await inviteWorkspaceMember(workspace.workspace_id, {
          identifier: u.user_id,
          role,
        });
        toast.success(res.status === "exists" ? "对方已是成员" : "邀请已发送");
      } else {
        await addWorkspaceMember(workspace.workspace_id, { identifier: u.user_id, role });
        toast.success(`已添加 ${u.display_name || u.username}`);
      }
      setQuery("");
      setResults([]);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function removeMember(m: WorkspaceMember) {
    try {
      await removeWorkspaceMember(workspace.workspace_id, m.user_id);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "移除失败");
    }
  }

  async function doDelete() {
    if (!confirm(`删除工作空间「${workspace.name}」？其下频道将一并删除，不可撤销。`)) return;
    try {
      await deleteWorkspace(workspace.workspace_id);
      setWorkspaces(workspaces.filter((w) => w.workspace_id !== workspace.workspace_id));
      selectWorkspace(personalWorkspace?.workspace_id ?? null);
      toast.success("工作空间已删除");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    }
  }

  async function changeRole(m: WorkspaceMember, role: string) {
    try {
      await setWorkspaceMemberRole(workspace.workspace_id, m.user_id, role);
      await refreshMembers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "改角色失败");
    }
  }

  async function leave() {
    if (!confirm(`退出工作空间「${workspace.name}」？`)) return;
    try {
      await leaveWorkspace(workspace.workspace_id);
      setWorkspaces(workspaces.filter((w) => w.workspace_id !== workspace.workspace_id));
      selectWorkspace(personalWorkspace?.workspace_id ?? null);
      toast.success("已退出工作空间");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "退出失败");
    }
  }

  return (
    <Dialog title={`工作空间设置 · ${workspace.name}`} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-5">
        {!canManage && (
          <p className="text-xs text-amber-400/80 bg-amber-950/30 rounded-lg px-3 py-2">
            你不是该工作空间的管理员，只能查看名称。
          </p>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">名称</label>
          <div className="flex gap-2">
            <input
              value={name}
              disabled={!canManage}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500 disabled:opacity-60"
            />
            {canManage && (
              <Button size="sm" loading={savingMeta} onClick={() => void saveMeta()}>
                保存
              </Button>
            )}
          </div>
        </div>

        {canManage && (
          <>
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
                成员 ({members.length})
              </label>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-800 divide-y divide-zinc-800/60">
                {members.map((m) => (
                  <div key={m.user_id} className="flex items-center gap-2 px-3 py-2">
                    <Avatar name={m.display_name || m.username} id={m.user_id} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-200 truncate">
                        {m.display_name || m.username}
                        {m.status === "pending" && (
                          <span className="ml-1.5 text-[10px] text-amber-400">待接受</span>
                        )}
                      </p>
                      {m.user_id !== me?.user_id ? (
                        <select
                          value={m.role}
                          onChange={(e) => void changeRole(m, e.target.value)}
                          className="mt-0.5 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300 outline-none"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-[11px] text-zinc-500">{m.role}</p>
                      )}
                    </div>
                    {m.user_id !== me?.user_id && m.role !== "owner" && (
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

              <div className="relative">
                <div className="flex items-center gap-2 rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2">
                  <UserPlus className="w-4 h-4 text-zinc-500" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索用户名…"
                    className="flex-1 bg-transparent text-sm text-zinc-200 outline-none"
                  />
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
                    className="bg-zinc-900 border border-zinc-800 rounded px-1.5 py-1 text-xs text-zinc-300 outline-none"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                {(results.length > 0 || searching) && (
                  <div className="absolute z-10 mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 shadow-lg max-h-44 overflow-y-auto">
                    {searching && (
                      <div className="px-3 py-2 text-xs text-zinc-500">搜索中…</div>
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
                        <button
                          onClick={() => void add(u, true)}
                          className="text-xs text-indigo-400 hover:text-indigo-300"
                        >
                          邀请
                        </button>
                        <button
                          onClick={() => void add(u, false)}
                          className="text-xs text-zinc-400 hover:text-zinc-200"
                        >
                          直接加
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="pt-2 border-t border-zinc-800 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-200">删除工作空间</p>
                <p className="text-xs text-zinc-500 mt-0.5">连同其下频道一并删除，不可撤销。</p>
              </div>
              <Button variant="danger" size="sm" onClick={() => void doDelete()}>
                <Trash2 className="w-3.5 h-3.5" />
                删除
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
              <p className="text-sm font-medium text-zinc-200">退出工作空间</p>
              <p className="text-xs text-zinc-500 mt-0.5">把自己移出该工作空间。</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void leave()}>
              <LogOut className="w-3.5 h-3.5" />
              退出
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
