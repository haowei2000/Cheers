import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import {
  BookOpenIcon,
  Cog6ToothIcon,
  ShieldCheckIcon,
  TrashIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { apiFetch } from "../api";
import type { Channel, ChannelMember, MemoryEntryItem } from "../types";
import { InviteMemberSearch } from "./InviteMemberSearch";
import { Modal, ModalFooter } from "./Modal";

type TabId = "general" | "members" | "memory";
type ApiEnvelope<T> = { status?: string; data?: T; detail?: string; message?: string };
type PromptTemplateItem = {
  template_id: string;
  name: string;
  description?: string | null;
};

const MEMORY_LAYERS = [
  { id: "ANCHOR", label: "锚点" },
  { id: "PROGRESS", label: "进展" },
  { id: "DECISIONS", label: "决策" },
] as const;

function roleText(role?: string | null): string {
  if (role === "owner") return "所有者";
  if (role === "admin") return "管理员";
  if (role === "workspace_admin") return "工作空间管理员";
  if (role === "system_admin") return "系统管理员";
  return "成员";
}

function initials(label: string): string {
  return (label.trim()[0] || "?").toUpperCase();
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok || data.status === "error") {
    throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  }
  return (data.data ?? data) as T;
}

export function ChannelSettingsModal({
  open,
  channel,
  userToken,
  currentUserId,
  onClose,
  onSaved,
}: {
  open: boolean;
  channel: Channel | null | undefined;
  userToken: string | null;
  currentUserId: string;
  onClose: () => void;
  onSaved: (channel: Channel) => void;
}) {
  const channelId = channel?.channel_id ?? "";
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [canInviteMembers, setCanInviteMembers] = useState(false);
  const [canAddBots, setCanAddBots] = useState(false);
  const [myRole, setMyRole] = useState<string | null>(null);

  const [name, setName] = useState(channel?.name ?? "");
  const [purpose, setPurpose] = useState(channel?.purpose ?? "");
  const [autoAssist, setAutoAssist] = useState(Boolean(channel?.auto_assist));
  const [allowMemberInvites, setAllowMemberInvites] = useState(
    channel?.allow_member_invites !== false,
  );
  const [allowBotAdds, setAllowBotAdds] = useState(channel?.allow_bot_adds !== false);

  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [templates, setTemplates] = useState<PromptTemplateItem[]>([]);

  const [memoryLayer, setMemoryLayer] = useState<(typeof MEMORY_LAYERS)[number]["id"]>("ANCHOR");
  const [entries, setEntries] = useState<MemoryEntryItem[]>([]);
  const [entryTitle, setEntryTitle] = useState("");
  const [entryContent, setEntryContent] = useState("");
  const [editingEntry, setEditingEntry] = useState<MemoryEntryItem | null>(null);

  const loadMemory = useCallback(
    async (layer = memoryLayer) => {
      if (!channelId || !open) return;
      const res = await apiFetch(`/channels/${channelId}/memory/?layer=${layer}`, {
        token: userToken,
      });
      const data = (await res.json().catch(() => [])) as MemoryEntryItem[];
      setEntries(Array.isArray(data) ? data : []);
    },
    [channelId, memoryLayer, open, userToken],
  );

  const loadSettings = useCallback(async () => {
    if (!channelId || !open) return;
    setLoading(true);
    try {
      const data = await parseEnvelope<{
        channel: Channel;
        permissions: {
          can_manage: boolean;
          can_invite_members?: boolean;
          can_add_bots?: boolean;
          my_role: string | null;
        };
        members: ChannelMember[];
      }>(
        await apiFetch(`/channels/${channelId}/settings`, { token: userToken }),
      );
      setName(data.channel.name);
      setPurpose(data.channel.purpose ?? "");
      setAutoAssist(Boolean(data.channel.auto_assist));
      setAllowMemberInvites(data.channel.allow_member_invites !== false);
      setAllowBotAdds(data.channel.allow_bot_adds !== false);
      setCanManage(Boolean(data.permissions.can_manage));
      setCanInviteMembers(Boolean(data.permissions.can_invite_members));
      setCanAddBots(Boolean(data.permissions.can_add_bots));
      setMyRole(data.permissions.my_role);
      setMembers(data.members || []);
    } catch (err) {
      toast.error((err as Error).message || "加载频道设置失败");
    } finally {
      setLoading(false);
    }
  }, [channelId, open, userToken]);

  const loadTemplates = useCallback(async () => {
    if (!open) return;
    try {
      const data = await parseEnvelope<PromptTemplateItem[]>(
        await apiFetch("/templates", { token: userToken }),
      );
      setTemplates(data || []);
    } catch {
      setTemplates([]);
    }
  }, [open, userToken]);

  useEffect(() => {
    if (!open || !channel) return;
    setActiveTab("general");
    loadSettings();
    loadTemplates();
    loadMemory("ANCHOR");
  }, [channel, loadMemory, loadSettings, loadTemplates, open]);

  useEffect(() => {
    if (open) loadMemory(memoryLayer);
  }, [loadMemory, memoryLayer, open]);

  const saveGeneral = async () => {
    if (!channelId || !canManage) return;
    setSaving(true);
    try {
      const updated = await parseEnvelope<Channel>(
        await apiFetch(`/channels/${channelId}/settings`, {
          method: "PATCH",
          token: userToken,
          body: {
            name: name.trim(),
            purpose: purpose.trim() || null,
            auto_assist: autoAssist,
            allow_member_invites: allowMemberInvites,
            allow_bot_adds: allowBotAdds,
          },
        }),
      );
      onSaved(updated);
      toast.success("频道设置已保存");
    } catch (err) {
      toast.error((err as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const removeMember = async (member: ChannelMember) => {
    if (!canManage) return;
    if (!confirm(`确定移除 ${member.display_name || member.username || member.member_id}？`)) {
      return;
    }
    try {
      await parseEnvelope<unknown>(
        await apiFetch(`/channels/${channelId}/members/${encodeURIComponent(member.member_id)}`, {
          method: "DELETE",
          token: userToken,
        }),
      );
      toast.success("成员已移除");
      loadSettings();
    } catch (err) {
      toast.error((err as Error).message || "移除失败");
    }
  };

  const updateRole = async (member: ChannelMember, role: string) => {
    if (!canManage || member.member_type !== "user") return;
    try {
      await parseEnvelope<unknown>(
        await apiFetch(
          `/channels/${channelId}/members/${encodeURIComponent(member.member_id)}/role`,
          {
            method: "PATCH",
            token: userToken,
            body: { role },
          },
        ),
      );
      toast.success("成员角色已更新");
      loadSettings();
    } catch (err) {
      toast.error((err as Error).message || "更新失败");
    }
  };

  const updateBotTemplate = async (member: ChannelMember, templateId: string | null) => {
    try {
      await parseEnvelope<unknown>(
        await apiFetch(
          `/channels/${channelId}/members/${encodeURIComponent(member.member_id)}/template`,
          {
            method: "PATCH",
            token: userToken,
            body: { template_id: templateId },
          },
        ),
      );
      toast.success("Bot 频道模板已更新");
      loadSettings();
    } catch (err) {
      toast.error((err as Error).message || "更新失败");
    }
  };

  const resetEntryForm = () => {
    setEditingEntry(null);
    setEntryTitle("");
    setEntryContent("");
  };

  const submitEntry = async () => {
    if (!canManage || !entryContent.trim()) return;
    const path = editingEntry
      ? `/channels/${channelId}/memory/${editingEntry.entry_id}`
      : `/channels/${channelId}/memory/`;
    try {
      const res = await apiFetch(path, {
        method: editingEntry ? "PUT" : "POST",
        token: userToken,
        body: {
          layer: memoryLayer,
          title: entryTitle.trim() || null,
          content: entryContent.trim(),
        },
      });
      if (!res.ok) throw new Error();
      resetEntryForm();
      loadMemory(memoryLayer);
      toast.success("记忆已保存");
    } catch {
      toast.error("保存记忆失败");
    }
  };

  const deleteEntry = async (entryId: string) => {
    if (!canManage || !confirm("确定删除这条记忆？")) return;
    try {
      const res = await apiFetch(`/channels/${channelId}/memory/${entryId}`, {
        method: "DELETE",
        token: userToken,
      });
      if (!res.ok) throw new Error();
      loadMemory(memoryLayer);
      toast.success("记忆已删除");
    } catch {
      toast.error("删除失败");
    }
  };

  const tabs: { id: TabId; label: string; icon: JSX.Element }[] = [
    { id: "general", label: "常规", icon: <Cog6ToothIcon /> },
    { id: "members", label: "成员", icon: <UsersIcon /> },
    { id: "memory", label: "记忆", icon: <BookOpenIcon /> },
  ];

  if (!channel) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="频道设置"
      description={`#${channel.name} · ${roleText(myRole)}`}
      maxWidth="max-w-5xl"
      panelClassName="overflow-hidden"
    >
      <div className="grid min-h-[560px] grid-cols-[180px_1fr] overflow-hidden rounded-lg border border-gray-200 bg-white">
        <nav className="border-r border-gray-200 bg-gray-50 p-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`mb-1 flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm ${
                activeTab === tab.id
                  ? "bg-white font-semibold text-gray-900 shadow-sm"
                  : "text-gray-600 hover:bg-white"
              }`}
            >
              <span className="h-4 w-4">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
          <div className="mt-4 rounded-md border border-gray-200 bg-white p-3 text-xs text-gray-500">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-gray-700">
              <ShieldCheckIcon className="h-4 w-4" />
              {canManage ? "可管理" : canInviteMembers || canAddBots ? "可邀请" : "只读"}
            </div>
            邀请成员和添加 Bot 可在常规中配置。
          </div>
        </nav>

        <section className="min-w-0 overflow-y-auto p-5">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400">
              加载中…
            </div>
          ) : activeTab === "general" ? (
            <div className="max-w-2xl space-y-5">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">频道名称</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!canManage}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-[#1264A3] focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">频道说明</label>
                <textarea
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  disabled={!canManage}
                  rows={4}
                  className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-[#1264A3] focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-3">
                <div>
                  <div className="text-sm font-medium text-gray-800">自动接管</div>
                  <div className="text-xs text-gray-500">开启后，频道内消息会自动调用内置助手协作处理。</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoAssist}
                  disabled={!canManage}
                  onClick={() => setAutoAssist((v) => !v)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                    autoAssist ? "bg-[#1264A3]" : "bg-gray-300"
                  }`}
                >
                  <span
                    className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
                    style={{ transform: autoAssist ? "translateX(22px)" : "translateX(4px)" }}
                  />
                </button>
              </div>
              <div className="space-y-2 rounded-md border border-gray-200 px-3 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-gray-800">成员邀请</div>
                    <div className="text-xs text-gray-500">允许普通成员邀请人类成员加入频道。</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={allowMemberInvites}
                    disabled={!canManage}
                    onClick={() => setAllowMemberInvites((v) => !v)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                      allowMemberInvites ? "bg-[#1264A3]" : "bg-gray-300"
                    }`}
                  >
                    <span
                      className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
                      style={{ transform: allowMemberInvites ? "translateX(22px)" : "translateX(4px)" }}
                    />
                  </button>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-gray-800">添加 Bot</div>
                    <div className="text-xs text-gray-500">允许普通成员添加自己可见的 Bot。</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={allowBotAdds}
                    disabled={!canManage}
                    onClick={() => setAllowBotAdds((v) => !v)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                      allowBotAdds ? "bg-[#1264A3]" : "bg-gray-300"
                    }`}
                  >
                    <span
                      className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
                      style={{ transform: allowBotAdds ? "translateX(22px)" : "translateX(4px)" }}
                    />
                  </button>
                </div>
              </div>
              <ModalFooter>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={saveGeneral}
                  disabled={!canManage || saving || !name.trim()}
                  className="rounded-md bg-[#1264A3] px-4 py-2 text-sm font-medium text-white hover:bg-[#0f5a94] disabled:opacity-50"
                >
                  {saving ? "保存中…" : "保存"}
                </button>
              </ModalFooter>
            </div>
          ) : activeTab === "members" ? (
            <div className="space-y-5">
              <InviteMemberSearch
                channelId={channelId}
                userToken={userToken}
                members={members}
                canInviteMembers={canInviteMembers}
                canAddBots={canAddBots}
                onInvited={loadSettings}
              />

              <div className="divide-y divide-gray-100 rounded-md border border-gray-200">
                {members.map((member) => {
                  const label = member.display_name || member.username || member.member_id;
                  const isUser = member.member_type === "user";
                  const canEditBotTemplate =
                    !isUser &&
                    (member.owner?.user_id === currentUserId || myRole === "system_admin");
                  return (
                    <div key={`${member.member_type}:${member.member_id}`} className="flex items-center gap-3 px-3 py-2.5">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-md text-sm font-semibold text-white ${isUser ? "bg-[#1264A3]" : "bg-[#2EB67D]"}`}>
                        {initials(label)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-gray-900">{label}</div>
                        <div className="truncate text-xs text-gray-500">
                          {member.username ? `@${member.username}` : member.member_id}
                        </div>
                      </div>
                      {isUser ? (
                        <select
                          value={member.role || "member"}
                          disabled={!canManage || member.member_id === currentUserId}
                          onChange={(e) => updateRole(member, e.target.value)}
                          className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 disabled:bg-gray-50"
                        >
                          <option value="member">成员</option>
                          <option value="admin">管理员</option>
                          <option value="owner">所有者</option>
                        </select>
                      ) : (
                        <span className="rounded-md bg-green-50 px-2 py-1 text-xs text-green-700">Bot</span>
                      )}
                      {!isUser && (
                        <select
                          value={member.template_id || ""}
                          disabled={!canEditBotTemplate}
                          onChange={(e) => updateBotTemplate(member, e.target.value || null)}
                          title={canEditBotTemplate ? "Bot 频道模板覆盖" : "只有 Bot 所有者可修改频道模板"}
                          className="w-40 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 disabled:bg-gray-50 disabled:text-gray-400"
                        >
                          <option value="">默认模板</option>
                          {templates.map((template) => (
                            <option key={template.template_id} value={template.template_id}>
                              {template.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        onClick={() => removeMember(member)}
                        disabled={!canManage || member.member_id === currentUserId}
                        className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                        title="移除"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
              <div>
                <div className="mb-3 flex rounded-md border border-gray-200 p-1">
                  {MEMORY_LAYERS.map((layer) => (
                    <button
                      key={layer.id}
                      type="button"
                      onClick={() => {
                        setMemoryLayer(layer.id);
                        resetEntryForm();
                      }}
                      className={`flex-1 rounded px-2 py-1.5 text-xs ${
                        memoryLayer === layer.id ? "bg-[#1264A3] text-white" : "text-gray-600"
                      }`}
                    >
                      {layer.label}
                    </button>
                  ))}
                </div>
                <div className="space-y-2">
                  <input
                    value={entryTitle}
                    onChange={(e) => setEntryTitle(e.target.value)}
                    disabled={!canManage}
                    placeholder="标题（可选）"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
                  />
                  <textarea
                    value={entryContent}
                    onChange={(e) => setEntryContent(e.target.value)}
                    disabled={!canManage}
                    rows={8}
                    placeholder="记忆内容"
                    className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
                  />
                  <div className="flex gap-2">
                    {editingEntry && (
                      <button
                        type="button"
                        onClick={resetEntryForm}
                        className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600"
                      >
                        取消编辑
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={submitEntry}
                      disabled={!canManage || !entryContent.trim()}
                      className="rounded-md bg-[#1264A3] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {editingEntry ? "保存修改" : "添加记忆"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="min-w-0 space-y-2">
                {entries.length === 0 ? (
                  <div className="rounded-md border border-dashed border-gray-200 py-16 text-center text-sm text-gray-400">
                    暂无记忆条目
                  </div>
                ) : (
                  entries.map((entry) => (
                    <div key={entry.entry_id} className="rounded-md border border-gray-200 p-3">
                      <div className="mb-2 flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-gray-900">
                            {entry.title || "无标题"}
                          </div>
                          <div className="text-xs text-gray-400">
                            {entry.updated_at ? new Date(entry.updated_at).toLocaleString("zh-CN") : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={!canManage}
                          onClick={() => {
                            setEditingEntry(entry);
                            setEntryTitle(entry.title || "");
                            setEntryContent(entry.content);
                          }}
                          className="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          disabled={!canManage}
                          onClick={() => deleteEntry(entry.entry_id)}
                          className="rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-50 disabled:opacity-40"
                        >
                          删除
                        </button>
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-6 text-gray-700">{entry.content}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
