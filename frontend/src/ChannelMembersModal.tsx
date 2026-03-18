import { useEffect, useState } from "react";
import toast from "react-hot-toast";

const API = "/api";

interface Member {
  member_id: string;
  member_type: "user" | "bot";
  username?: string;
  display_name?: string;
  avatar_url?: string;
}

interface Friend {
  user_id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
}

interface Bot {
  bot_id: string;
  username: string;
  display_name?: string;
  intro?: string;
}

interface ChannelMembersModalProps {
  channelId: string;
  channelName: string;
  currentUserId: string;
  userToken?: string;
  isOpen: boolean;
  onClose: () => void;
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

  // 邀请相关状态
  const [inviteQuery, setInviteQuery] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [selectedFriends, setSelectedFriends] = useState<Set<string>>(new Set());

  // Bot 邀请状态
  const [allBots, setAllBots] = useState<Bot[]>([]);
  const [addingBotId, setAddingBotId] = useState<string | null>(null);

  // 加载频道成员
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

  // 加载可邀请的好友
  const loadFriendsToInvite = async () => {
    try {
      const res = await fetch(
        `${API}/channels/${channelId}/friends-to-invite?user_id=${encodeURIComponent(currentUserId)}`,
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

  // 邀请单个好友
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

  // 批量邀请好友
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

  // 通过ID/用户名邀请
  const inviteByIdentifier = async () => {
    if (!inviteQuery.trim()) {
      toast.error("请输入用户ID或用户名");
      return;
    }
    
    setInviteLoading(true);
    try {
      const res = await fetch(`${API}/channels/${channelId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          inviter_id: currentUserId,
          identifier: inviteQuery.trim(),
        }),
      });
      const data = await res.json();
      if (data.status === "success") {
        toast.success(data.message || "邀请成功");
        setInviteQuery("");
        loadMembers();
        loadFriendsToInvite();
      } else {
        toast.error(data.detail || "邀请失败");
      }
    } catch (err) {
      toast.error("邀请失败");
    } finally {
      setInviteLoading(false);
    }
  };

  // 移除成员
  const removeMember = async (memberId: string, memberType: string) => {
    if (memberType === "bot") {
      // Bot 保留原有的移除逻辑
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

  // 加载所有 Bot
  const loadAllBots = async () => {
    try {
      const res = await fetch(`${API}/bots`, { headers: authHeaders });
      const data = await res.json();
      if (data.status === "success") {
        setAllBots(data.data || []);
      }
    } catch {
      setAllBots([]);
    }
  };

  // 添加 Bot 到频道
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
      loadAllBots();
    }
  }, [isOpen, channelId]);

  const botMembers = members.filter((m) => m.member_type === "bot");
  const userMembers = members.filter((m) => m.member_type === "user");

  if (!isOpen) return null;

  const botMemberIds = new Set(botMembers.map((m) => m.member_id));
  const availableBots = allBots.filter((b) => !botMemberIds.has(b.bot_id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-bold text-gray-900">频道成员</h2>
            <p className="text-xs text-gray-500">#{channelName}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl"
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setActiveTab("members")}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "members"
                ? "text-[#1264A3] border-b-2 border-[#1264A3]"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            当前成员 ({members.length})
          </button>
          <button
            onClick={() => setActiveTab("invite")}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "invite"
                ? "text-[#1264A3] border-b-2 border-[#1264A3]"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            邀请好友 {friends.length > 0 && `(${friends.length})`}
          </button>
          <button
            onClick={() => setActiveTab("invite_by_id")}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "invite_by_id"
                ? "text-[#1264A3] border-b-2 border-[#1264A3]"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            通过ID邀请
          </button>
          <button
            onClick={() => setActiveTab("invite_bot")}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "invite_bot"
                ? "text-[#1264A3] border-b-2 border-[#1264A3]"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            邀请 Bot
          </button>
        </div>

        {/* Content */}
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          {activeTab === "members" && (
            // 成员列表
            loading ? (
              <div className="text-center py-8 text-gray-500">
                <div className="animate-spin w-6 h-6 border-2 border-[#1264A3] border-t-transparent rounded-full mx-auto mb-2"></div>
                加载中...
              </div>
            ) : (
              <div className="space-y-4">
                {/* 用户列表 */}
                {userMembers.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      用户 ({userMembers.length})
                    </h3>
                    <div className="space-y-1">
                      {userMembers.map((member) => (
                        <div
                          key={member.member_id}
                          className="flex items-center justify-between p-2 bg-gray-50 rounded-lg"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-[#1264A3] flex items-center justify-center text-white text-sm font-bold">
                              {(member.display_name || member.username || "?").charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-sm text-gray-900">
                                {member.display_name || member.username || "未知用户"}
                              </p>
                              {member.username && (
                                <p className="text-xs text-gray-500">@{member.username}</p>
                              )}
                            </div>
                          </div>
                          {member.member_id !== currentUserId && (
                            <button
                              onClick={() => removeMember(member.member_id, member.member_type)}
                              className="text-red-500 text-xs hover:text-red-700 px-2 py-1"
                            >
                              移除
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Bot 列表 */}
                {botMembers.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Bot ({botMembers.length})
                    </h3>
                    <div className="space-y-1">
                      {botMembers.map((member) => (
                        <div
                          key={member.member_id}
                          className="flex items-center justify-between p-2 bg-green-50 rounded-lg"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded bg-[#2EB67D] flex items-center justify-center text-white text-sm font-bold">
                              {(member.display_name || member.username || "B").charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-sm text-gray-900">
                                {member.display_name || member.username || "未知 Bot"}
                              </p>
                              {member.username && (
                                <p className="text-xs text-gray-500">@{member.username}</p>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => removeMember(member.member_id, member.member_type)}
                            className="text-red-500 text-xs hover:text-red-700 px-2 py-1"
                          >
                            移除
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {members.length === 0 && (
                  <div className="text-center py-8 text-gray-500">
                    <div className="text-4xl mb-2">👥</div>
                    <p>暂无成员</p>
                  </div>
                )}
              </div>
            )
          )}

          {activeTab === "invite" && (
            // 邀请好友
            <div>
              {friends.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-4xl mb-2">🤝</div>
                  <p className="text-gray-500 mb-2">暂无可邀请的好友</p>
                  <p className="text-xs text-gray-400">所有好友都已在频道中</p>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex items-center justify-between">
                    <p className="text-sm text-gray-600">
                      选择好友邀请加入频道 ({selectedFriends.size} 已选)
                    </p>
                    {selectedFriends.size > 0 && (
                      <button
                        onClick={inviteSelectedFriends}
                        disabled={inviteLoading}
                        className="px-3 py-1.5 bg-[#007a5a] text-white rounded text-sm font-medium hover:bg-[#006a4d] disabled:opacity-50"
                      >
                        {inviteLoading ? "邀请中..." : "批量邀请"}
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
                          className={`flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors ${
                            isSelected ? "bg-blue-50 border border-[#1264A3]/30" : "bg-gray-50 hover:bg-gray-100"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {}}
                              onClick={(e) => e.stopPropagation()}
                              className="accent-[#1264A3]"
                            />
                            <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center text-white text-sm font-bold">
                              {(friend.display_name || friend.username).charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-sm text-gray-900">
                                {friend.display_name || friend.username}
                              </p>
                              <p className="text-xs text-gray-500">@{friend.username}</p>
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              inviteFriend(friend.user_id);
                            }}
                            disabled={inviteLoading}
                            className="px-2 py-1 text-xs bg-[#1264A3] text-white rounded hover:bg-[#0f5a94] disabled:opacity-50"
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
            // 通过ID/用户名邀请
            <div>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  用户ID 或 用户名
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={inviteQuery}
                    onChange={(e) => setInviteQuery(e.target.value)}
                    placeholder="输入用户ID或用户名"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
                    onKeyDown={(e) => e.key === "Enter" && inviteByIdentifier()}
                  />
                  <button
                    onClick={inviteByIdentifier}
                    disabled={inviteLoading || !inviteQuery.trim()}
                    className="px-4 py-2 bg-[#007a5a] text-white rounded-lg text-sm font-medium hover:bg-[#006a4d] disabled:opacity-50"
                  >
                    {inviteLoading ? "邀请中..." : "邀请"}
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  提示：可以直接输入用户的ID或用户名来邀请，即使不是你的好友也可以邀请。
                </p>
              </div>
            </div>
          )}

          {activeTab === "invite_bot" && (
            // 邀请 Bot
            availableBots.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-4xl mb-2">🤖</div>
                <p className="text-gray-500 mb-1">
                  {allBots.length === 0 ? "暂无可用 Bot" : "所有 Bot 都已在频道中"}
                </p>
                <p className="text-xs text-gray-400">可前往管理页面创建新 Bot</p>
              </div>
            ) : (
              <div className="space-y-2">
                {availableBots.map((bot) => (
                  <div
                    key={bot.bot_id}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded bg-[#2EB67D] flex items-center justify-center text-white text-sm font-bold">
                        {(bot.display_name || bot.username).charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-sm text-gray-900">
                          {bot.display_name || bot.username}
                        </p>
                        <p className="text-xs text-gray-500">@{bot.username}</p>
                        {bot.intro && (
                          <p className="text-xs text-gray-400 truncate max-w-[200px]">{bot.intro}</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => addBot(bot.bot_id)}
                      disabled={addingBotId === bot.bot_id}
                      className="px-3 py-1.5 text-xs bg-[#2EB67D] text-white rounded hover:bg-[#27a36e] disabled:opacity-50 whitespace-nowrap"
                    >
                      {addingBotId === bot.bot_id ? "添加中..." : "添加"}
                    </button>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
