import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../api";
import type { Channel, ChannelMember } from "../types";
import { AppIcon } from "./icons/AppIcon";
import { MemberListItem } from "./members";
import { Modal, ModalFooter } from "./Modal";

type TabId = "channel" | "admins" | "bots";
type ChannelScope = "workspace" | "private";
type ApiEnvelope<T> = {
  status?: string;
  data?: T;
  detail?: string;
  message?: string;
};
type PromptTemplateItem = {
  template_id: string;
  name: string;
  description?: string | null;
};

function roleText(role?: string | null): string {
  if (role === "owner") return "所有者";
  if (role === "admin") return "管理员";
  if (role === "workspace_admin") return "工作空间管理员";
  if (role === "system_admin") return "系统管理员";
  return "成员";
}

function normalizeScope(value?: string | null): ChannelScope {
  return value === "private" ? "private" : "workspace";
}

function scopeApiValue(value: ChannelScope): "public" | "private" {
  return value === "workspace" ? "public" : "private";
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
  const [activeTab, setActiveTab] = useState<TabId>("channel");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [canInviteMembers, setCanInviteMembers] = useState(false);
  const [canAddBots, setCanAddBots] = useState(false);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [autoAssist, setAutoAssist] = useState(Boolean(channel?.auto_assist));
  const [allowMemberInvites, setAllowMemberInvites] = useState(
    channel?.allow_member_invites !== false,
  );
  const [allowBotAdds, setAllowBotAdds] = useState(channel?.allow_bot_adds !== false);
  const [channelScope, setChannelScope] = useState<ChannelScope>(
    normalizeScope(channel?.type),
  );
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [templates, setTemplates] = useState<PromptTemplateItem[]>([]);

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
      setAutoAssist(Boolean(data.channel.auto_assist));
      setAllowMemberInvites(data.channel.allow_member_invites !== false);
      setAllowBotAdds(data.channel.allow_bot_adds !== false);
      setChannelScope(normalizeScope(data.channel.type));
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
    setActiveTab("channel");
    loadSettings();
    loadTemplates();
  }, [channel, loadSettings, loadTemplates, open]);

  const saveChannelControls = async () => {
    if (!channelId || !canManage) return;
    setSaving(true);
    try {
      const updated = await parseEnvelope<Channel>(
        await apiFetch(`/channels/${channelId}/settings`, {
          method: "PATCH",
          token: userToken,
          body: {
            auto_assist: autoAssist,
            type: scopeApiValue(channelScope),
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

  const tabs: { id: TabId; label: string; icon: JSX.Element }[] = [
    { id: "channel", label: "频道", icon: <AppIcon name="settings" /> },
    { id: "admins", label: "管理员", icon: <AppIcon name="users" /> },
    { id: "bots", label: "Bot 模板", icon: <AppIcon name="model" /> },
  ];
  const userMembers = members
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => member.member_type === "user")
    .sort((a, b) => {
      const aSelf = a.member.member_id === currentUserId;
      const bSelf = b.member.member_id === currentUserId;
      if (aSelf !== bSelf) return aSelf ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ member }) => member);
  const botMembers = members
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => member.member_type === "bot")
    .sort((a, b) => a.index - b.index)
    .map(({ member }) => member);

  if (!channel) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="频道设置"
      description={`#${channel.name} · ${roleText(myRole)}`}
      maxWidth="max-w-3xl"
      panelClassName="overflow-hidden"
    >
      <div className="grid min-h-[460px] grid-cols-[160px_1fr] overflow-hidden rounded-lg border border-gray-200 bg-white">
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
              <AppIcon name="shieldCheck" className="h-4 w-4" />
              {canManage ? "可管理" : canInviteMembers || canAddBots ? "可邀请" : "只读"}
            </div>
            邀请成员和添加 Bot 可在频道中配置。
          </div>
        </nav>

        <section className="min-w-0 overflow-y-auto p-5">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400">
              加载中…
            </div>
          ) : activeTab === "channel" ? (
            <div className="max-w-xl space-y-5">
              <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-3">
                <div>
                  <div className="text-sm font-medium text-gray-800">
                    自动接管
                  </div>
                  <div className="text-xs text-gray-500">
                    开启后，频道内消息会自动调用内置助手协作处理。
                  </div>
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
                    style={{
                      transform: autoAssist
                        ? "translateX(22px)"
                        : "translateX(4px)",
                    }}
                  />
                </button>
              </div>

              <div className="rounded-md border border-gray-200 px-3 py-3">
                <label className="mb-2 block text-sm font-medium text-gray-800">
                  频道范围
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(["workspace", "private"] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      disabled={!canManage}
                      onClick={() => setChannelScope(scope)}
                      className={`rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                        channelScope === scope
                          ? "border-[#1264A3] bg-blue-50 text-[#1264A3]"
                          : "border-gray-200 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      <div className="font-medium">
                        {scope === "workspace" ? "Workspace" : "Private"}
                      </div>
                      <div className="text-xs text-gray-500">
                        {scope === "workspace"
                          ? "工作空间频道；新成员自动加入"
                          : "私有频道；仅频道成员可见"}
                      </div>
                    </button>
                  ))}
                </div>
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
                      style={{
                        transform: allowMemberInvites
                          ? "translateX(22px)"
                          : "translateX(4px)",
                      }}
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
                      style={{
                        transform: allowBotAdds
                          ? "translateX(22px)"
                          : "translateX(4px)",
                      }}
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
                  onClick={saveChannelControls}
                  disabled={!canManage || saving}
                  className="rounded-md bg-[#1264A3] px-4 py-2 text-sm font-medium text-white hover:bg-[#0f5a94] disabled:opacity-50"
                >
                  {saving ? "保存中…" : "保存"}
                </button>
              </ModalFooter>
            </div>
          ) : activeTab === "admins" ? (
            <div className="space-y-3">
              <div className="text-sm font-semibold text-gray-900">
                管理员设置
              </div>
              <div className="divide-y divide-gray-100 rounded-md border border-gray-200">
                {userMembers.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-400">
                    暂无用户成员
                  </div>
                ) : (
                  userMembers.map((member) => {
                    const label =
                      member.display_name || member.username || member.member_id;
                    return (
                      <MemberListItem
                        key={member.member_id}
                        id={member.member_id}
                        kind="user"
                        username={member.username}
                        displayName={label}
                        avatarUrl={member.avatar_url}
                        subtitle={member.username ? `@${member.username}` : member.member_id}
                        self={member.member_id === currentUserId}
                        variant="panel"
                        compact
                        className="rounded-none px-3 py-2.5"
                        actions={
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
                        }
                      />
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm font-semibold text-gray-900">
                Bot 频道模板
              </div>
              <div className="divide-y divide-gray-100 rounded-md border border-gray-200">
                {botMembers.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-400">
                    暂无 Bot 成员
                  </div>
                ) : (
                  botMembers.map((member) => {
                    const label =
                      member.display_name || member.username || member.member_id;
                    const canEditTemplate =
                      member.can_manage_template ??
                      (member.added_by === currentUserId || myRole === "system_admin");
                    return (
                      <MemberListItem
                        key={member.member_id}
                        id={member.member_id}
                        kind="bot"
                        username={member.username}
                        displayName={label}
                        avatarUrl={member.avatar_url}
                        subtitle={member.username ? `@${member.username}` : member.member_id}
                        variant="panel"
                        compact
                        className="rounded-none px-3 py-2.5"
                        actions={
                          <select
                            value={member.template_id || ""}
                            disabled={!canEditTemplate}
                            onChange={(e) => updateBotTemplate(member, e.target.value || null)}
                            title={
                              canEditTemplate
                                ? "Bot 频道模板覆盖"
                                : "只有邀请该 Bot 入频道的人可修改频道模板"
                            }
                            className="w-44 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 disabled:bg-gray-50 disabled:text-gray-400"
                          >
                            <option value="">默认模板</option>
                            {templates.map((template) => (
                              <option
                                key={template.template_id}
                                value={template.template_id}
                              >
                                {template.name}
                              </option>
                            ))}
                          </select>
                        }
                      />
                    );
                  })
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
