import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import type { ChannelMember as Member, Friend, BotItem as Bot } from "./types";
import { AppIcon } from "./components/icons/AppIcon";
import { MemberAvatar, MemberRow, MemberSection } from "./components/members";
import { Modal } from "./components/Modal";
import { SearchPicker } from "./components/SearchPicker";

const API = "/api/v1";

interface PromptTemplateItem {
  template_id: string;
  name: string;
  description?: string;
}

interface ChannelMembersModalProps {
  channelId: string;
  channelName: string;
  currentUserId: string;
  userToken?: string;
  isOpen: boolean;
  onClose: () => void;
}

function botOnlineText(bot: Pick<Bot, "binding_type" | "connection_status" | "is_online" | "status">) {
  if ((bot.binding_type || "http") !== "agent_bridge") {
    return bot.is_online === false || bot.status === "offline" ? "已停用" : "HTTP 已启用";
  }
  if (bot.connection_status === "online" && bot.is_online) return "Bridge 在线";
  if (bot.connection_status === "partial") return "Bridge 部分连接";
  return "Bridge 离线";
}

function BotOnlinePill({ bot }: { bot: Pick<Bot, "binding_type" | "connection_status" | "is_online" | "status"> }) {
  const text = botOnlineText(bot);
  const isGood = text.includes("在线") || text.includes("启用");
  const isPartial = text.includes("部分");
  return (
    <span
      className={`an-chip ${
        isGood
          ? "green"
          : isPartial
            ? "orange"
            : "red"
      }`}
    >
      {text}
    </span>
  );
}

function botScopeText(scope?: Bot["scope"]) {
  if (scope === "private") return "Private";
  if (scope === "everyone") return "Everyone";
  return "Friend";
}

function botOwnerText(bot: Pick<Bot, "owner">) {
  return bot.owner?.display_name || bot.owner?.username || "系统";
}

export default function ChannelMembersModal({
  channelId,
  channelName,
  currentUserId,
  userToken,
  isOpen,
  onClose,
}: ChannelMembersModalProps) {
  const authHeaders: Record<string, string> = userToken ? { Authorization: `Bearer ${userToken}` } : {};
  const [members, setMembers] = useState<Member[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"members" | "invite" | "invite_by_id" | "invite_bot">("members");

  // Invitation state.
  const [inviteLoading, setInviteLoading] = useState(false);
  const [selectedFriends, setSelectedFriends] = useState<Set<string>>(new Set());

  // Bot invitation state.
  const [addingBotId, setAddingBotId] = useState<string | null>(null);

  // Prompt templates.
  const [allTemplates, setAllTemplates] = useState<PromptTemplateItem[]>([]);

  // Load channel members.
  const loadMembers = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/channels/${channelId}/members?with_username=1`, { headers: authHeaders });
      const data = await res.json();
      if (data.status === "success") {
        setMembers(data.data || []);
      }
    } catch (err) {
      console.error("加载成员失败:", err);
    } finally {
      setLoading(false);
    }
  };

  // Load friends that can be invited.
  const loadFriendsToInvite = async () => {
    try {
      const res = await fetch(
        `${API}/channels/${channelId}/friends-to-invite`,
        { headers: authHeaders }
      );
      const data = await res.json();
      if (data.status === "success") {
        setFriends(data.data || []);
      }
    } catch (err) {
      console.error("加载好友列表失败:", err);
    }
  };

  // Invite one friend.
  const inviteFriend = async (friendId: string) => {
    setInviteLoading(true);
    try {
      const res = await fetch(`${API}/channels/${channelId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          member_id: friendId,
          member_type: "user",
        }),
      });
      const data = await res.json();
      if (data.status === "success") {
        toast.success("邀请成功");
        loadMembers();
        loadFriendsToInvite();
        setSelectedFriends((prev) => {
          const next = new Set(prev);
          next.delete(friendId);
          return next;
        });
      } else {
        toast.error(data.detail || "邀请失败");
      }
    } catch (err) {
      toast.error("邀请失败");
    } finally {
      setInviteLoading(false);
    }
  };

  // Invite selected friends in bulk.
  const inviteSelectedFriends = async () => {
    if (selectedFriends.size === 0) {
      toast.error("请先选择好友");
      return;
    }

    setInviteLoading(true);
    let successCount = 0;
    let failCount = 0;

    for (const friendId of selectedFriends) {
      try {
        const res = await fetch(`${API}/channels/${channelId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            member_id: friendId,
            member_type: "user",
          }),
        });
        const data = await res.json();
        if (data.status === "success") {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    setInviteLoading(false);
    if (successCount > 0) {
      toast.success(`成功邀请 ${successCount} 位好友`);
      loadMembers();
      loadFriendsToInvite();
      setSelectedFriends(new Set());
    }
    if (failCount > 0) {
      toast.error(`${failCount} 位好友邀请失败`);
    }
  };

  // Remove a member.
  const removeMember = async (memberId: string, memberType: string) => {
    if (memberType === "bot") {
      // Preserve the existing removal flow for bots.
      if (!confirm("确定要移除这个 Bot 吗？")) return;
    } else {
      if (!confirm("确定要移除这个成员吗？")) return;
    }

    try {
      const res = await fetch(
        `${API}/channels/${channelId}/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE", headers: authHeaders }
      );
      const data = await res.json();
      if (data.status === "success") {
        toast.success("已移除");
        loadMembers();
        loadFriendsToInvite();
      } else {
        toast.error(data.detail || "移除失败");
      }
    } catch (err) {
      toast.error("移除失败");
    }
  };

  // Load all prompt templates.
  const loadTemplates = async () => {
    try {
      const res = await fetch(`${API}/templates`, { headers: authHeaders });
      const data = await res.json();
      if (data.status === "success") {
        setAllTemplates(data.data || []);
      }
    } catch {
      setAllTemplates([]);
    }
  };

  // Update the bot's channel-level prompt template.
  const updateBotTemplate = async (memberId: string, templateId: string | null) => {
    try {
      const res = await fetch(
        `${API}/channels/${channelId}/members/${encodeURIComponent(memberId)}/template`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ template_id: templateId || null }),
        }
      );
      const data = await res.json();
      if (data.status === "success") {
        toast.success("提示词模板已更新");
        loadMembers();
      } else {
        toast.error(data.detail || "更新失败");
      }
    } catch {
      toast.error("更新失败");
    }
  };

  // Add a bot to the channel.
  const addBot = async (botId: string) => {
    setAddingBotId(botId);
    try {
      const res = await fetch(`${API}/channels/${channelId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ member_id: botId, member_type: "bot" }),
      });
      const data = await res.json();
      if (data.status === "success") {
        toast.success("Bot 已添加");
        loadMembers();
      } else {
        toast.error(data.detail || "添加失败");
      }
    } catch {
      toast.error("添加失败");
    } finally {
      setAddingBotId(null);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadMembers();
      loadFriendsToInvite();
      loadTemplates();
    }
  }, [isOpen, channelId]);

  const botMembers = members.filter((m) => m.member_type === "bot");
  const userMembers = members.filter((m) => m.member_type === "user");

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="频道成员"
      description={`#${channelName}`}
      maxWidth="max-w-lg"
      panelClassName="an-token-panel max-h-[85vh] overflow-hidden"
    >
      <div className="-mx-5 -my-4 flex min-h-0 flex-col">
        {/* Tabs */}
        <div className="an-tabs px-3">
          <button
            type="button"
            onClick={() => setActiveTab("members")}
            className={`an-tab ${activeTab === "members" ? "on" : ""}`}
          >
            当前成员 ({members.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("invite")}
            className={`an-tab ${activeTab === "invite" ? "on" : ""}`}
          >
            邀请好友 {friends.length > 0 && `(${friends.length})`}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("invite_by_id")}
            className={`an-tab ${activeTab === "invite_by_id" ? "on" : ""}`}
          >
            搜索用户
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("invite_bot")}
            className={`an-tab ${activeTab === "invite_bot" ? "on" : ""}`}
          >
            邀请 Bot
          </button>
        </div>

        {/* Content */}
        <div className="max-h-[60vh] overflow-y-auto p-4">
          {activeTab === "members" && (
            // Member list.
            loading ? (
              <div className="an-type-meta py-8 text-center">
                <div className="animate-spin w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full mx-auto mb-2"></div>
                加载中…
              </div>
            ) : (
              <div className="space-y-4">
                {userMembers.length > 0 && (
                  <MemberSection title="用户" count={userMembers.length}>
                    {userMembers.map((member) => (
                      <MemberRow
                        key={member.member_id}
                        as="article"
                        member={member}
                        badge={
                          member.member_id === currentUserId ? (
                            <span className="an-tag-pill self">我</span>
                          ) : undefined
                        }
                        action={
                          member.member_id !== currentUserId && (
                            <button
                              type="button"
                              onClick={() => removeMember(member.member_id, member.member_type)}
                              className="an-btn an-btn-danger an-btn-sm"
                            >
                              移除
                            </button>
                          )
                        }
                      />
                    ))}
                  </MemberSection>
                )}

                {botMembers.length > 0 && (
                  <MemberSection title="Bot" count={botMembers.length}>
                    {botMembers.map((member) => {
                      const canEditTemplate =
                        member.can_manage_template ?? member.added_by === currentUserId;
                      return (
                        <div key={member.member_id} className="space-y-2">
                          <MemberRow
                            as="article"
                            member={member}
                            badge={<BotOnlinePill bot={member} />}
                            meta={`${botScopeText(member.scope)} · Owner: ${botOwnerText(member)}`}
                            action={
                              <button
                                type="button"
                                onClick={() => removeMember(member.member_id, member.member_type)}
                                className="an-btn an-btn-danger an-btn-sm"
                              >
                                移除
                              </button>
                            }
                          />
                          {/* Prompt template selector. */}
                          <div className="ml-11 flex items-center gap-2">
                            <label className="an-label whitespace-nowrap">提示词模板:</label>
                            <select
                              value={member.template_id || ""}
                              onChange={(e) => updateBotTemplate(member.member_id, e.target.value || null)}
                              disabled={!canEditTemplate}
                              title={canEditTemplate ? "Bot 频道模板覆盖" : "只有邀请该 Bot 入频道的人可修改频道模板"}
                              className="an-select h-8 flex-1 py-1 text-xs"
                            >
                              <option value="">默认 (Bot 自带)</option>
                              {allTemplates.map((t) => (
                                <option key={t.template_id} value={t.template_id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      );
                    })}
                  </MemberSection>
                )}

                {members.length === 0 && (
                  <div className="an-type-meta py-8 text-center">
                    <AppIcon name="users" className="mx-auto mb-2 h-10 w-10 text-[var(--fg-3)]" />
                    <p>暂无成员</p>
                  </div>
                )}
              </div>
            )
          )}

          {activeTab === "invite" && (
            // Invite friends.
            <div>
              {friends.length === 0 ? (
                <div className="py-8 text-center">
                  <AppIcon name="userPlus" className="mx-auto mb-3 h-10 w-10 text-[var(--fg-3)]" />
                  <p className="an-type-body mb-1">暂无可邀请的好友</p>
                  <p className="an-type-meta">所有好友都已在频道中</p>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex items-center justify-between">
                    <p className="an-type-meta">
                      选择好友邀请加入频道 ({selectedFriends.size} 已选)
                    </p>
                    {selectedFriends.size > 0 && (
                      <button
                        onClick={inviteSelectedFriends}
                        disabled={inviteLoading}
                        className="an-btn an-btn-primary an-btn-sm"
                      >
                        {inviteLoading ? "邀请中…" : "批量邀请"}
                      </button>
                    )}
                  </div>
                  <div className="space-y-2">
                    {friends.map((friend) => {
                      const isSelected = selectedFriends.has(friend.user_id);
                      return (
                        <div
                          key={friend.user_id}
                          onClick={() => {
                            setSelectedFriends((prev) => {
                              const next = new Set(prev);
                              if (next.has(friend.user_id)) {
                                next.delete(friend.user_id);
                              } else {
                                next.add(friend.user_id);
                              }
                              return next;
                            });
                          }}
                          className={`flex cursor-pointer items-center justify-between rounded-md border p-3 transition-colors ${
                            isSelected ? "border-[var(--accent)] bg-[var(--accent-muted)]" : "border-[var(--border)] bg-[var(--bg-0)] hover:bg-[var(--surface-soft)]"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {}}
                              onClick={(e) => e.stopPropagation()}
                              className="accent-[var(--accent)]"
                            />
                            <MemberAvatar
                              avatarUrl={friend.avatar_url}
                              kind="user"
                              label={friend.display_name || friend.username}
                              size={32}
                            />
                            <div className="min-w-0">
                              <p className="an-type-body truncate font-medium">
                                {friend.display_name || friend.username}
                              </p>
                              <p className="an-type-meta truncate">@{friend.username}</p>
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              inviteFriend(friend.user_id);
                            }}
                            disabled={inviteLoading}
                            className="an-btn an-btn-primary an-btn-sm"
                          >
                            邀请
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === "invite_by_id" && (
            <div>
              <div className="mb-4">
                <label className="an-label mb-1 block">
                  用户
                </label>
                <SearchPicker
                  context="channel_invite_user"
                  token={userToken}
                  channelId={channelId}
                  modal
                  placeholder="搜索用户"
                  actionLabel={inviteLoading ? "邀请中" : "邀请"}
                  onSelect={(selection) => {
                    if (selection.type === "user") inviteFriend(selection.item.user_id);
                  }}
                />
              </div>
            </div>
          )}

          {activeTab === "invite_bot" && (
            <SearchPicker
              context="channel_invite_bot"
              token={userToken}
              channelId={channelId}
              modal
              placeholder="搜索 Bot"
              actionLabel={(selection) => {
                if (selection.type !== "bot") return null;
                return addingBotId === selection.item.bot_id ? "添加中" : "添加";
              }}
              onSelect={(selection) => {
                if (selection.type === "bot") addBot(selection.item.bot_id);
              }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
