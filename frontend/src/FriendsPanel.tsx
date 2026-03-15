import { useEffect, useState } from "react";
import toast from "react-hot-toast";

const API = "/api";

interface Friend {
  user_id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
}

interface UserSearchResult {
  user_id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
}

interface FriendsPanelProps {
  currentUserId: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function FriendsPanel({ currentUserId, isOpen, onClose }: FriendsPanelProps) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeTab, setActiveTab] = useState<"list" | "add">("list");

  // 加载好友列表
  const loadFriends = async () => {
    if (!currentUserId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/friends/${currentUserId}`);
      const data = await res.json();
      if (data.status === "success") {
        setFriends(data.data || []);
      }
    } catch (err) {
      console.error("加载好友列表失败:", err);
    } finally {
      setLoading(false);
    }
  };

  // 搜索用户
  const searchUsers = async () => {
    if (!searchQuery.trim() || !currentUserId) return;
    setSearching(true);
    try {
      const res = await fetch(
        `${API}/friends/search?query=${encodeURIComponent(searchQuery)}&current_user_id=${encodeURIComponent(currentUserId)}`
      );
      const data = await res.json();
      if (data.status === "success") {
        setSearchResults(data.data || []);
      }
    } catch (err) {
      console.error("搜索用户失败:", err);
    } finally {
      setSearching(false);
    }
  };

  // 添加好友
  const addFriend = async (friendIdentifier: string) => {
    try {
      const res = await fetch(`${API}/friends`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: currentUserId,
          friend_identifier: friendIdentifier,
        }),
      });
      const data = await res.json();
      if (data.status === "success") {
        toast.success(data.message || "添加好友成功");
        loadFriends();
        setActiveTab("list");
        setSearchQuery("");
        setSearchResults([]);
      } else {
        toast.error(data.detail || "添加好友失败");
      }
    } catch (err) {
      toast.error("添加好友失败");
    }
  };

  // 删除好友
  const removeFriend = async (friendId: string) => {
    if (!confirm("确定要删除这个好友吗？")) return;
    try {
      const res = await fetch(`${API}/friends`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: currentUserId,
          friend_id: friendId,
        }),
      });
      const data = await res.json();
      if (data.status === "success") {
        toast.success("已删除好友");
        loadFriends();
      } else {
        toast.error(data.detail || "删除好友失败");
      }
    } catch (err) {
      toast.error("删除好友失败");
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadFriends();
    }
  }, [isOpen, currentUserId]);

  useEffect(() => {
    // 延迟搜索，避免频繁请求
    const timer = setTimeout(() => {
      if (searchQuery.trim() && activeTab === "add") {
        searchUsers();
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, activeTab]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">好友管理</h2>
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
            onClick={() => setActiveTab("list")}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "list"
                ? "text-[#1264A3] border-b-2 border-[#1264A3]"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            我的好友 {friends.length > 0 && `(${friends.length})`}
          </button>
          <button
            onClick={() => setActiveTab("add")}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "add"
                ? "text-[#1264A3] border-b-2 border-[#1264A3]"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            添加好友
          </button>
        </div>

        {/* Content */}
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          {activeTab === "list" ? (
            // 好友列表
            loading ? (
              <div className="text-center py-8 text-gray-500">
                <div className="animate-spin w-6 h-6 border-2 border-[#1264A3] border-t-transparent rounded-full mx-auto mb-2"></div>
                加载中...
              </div>
            ) : friends.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-4xl mb-2">👥</div>
                <p className="text-gray-500 text-sm">暂无好友</p>
                <button
                  onClick={() => setActiveTab("add")}
                  className="mt-3 text-[#1264A3] text-sm hover:underline"
                >
                  添加好友
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {friends.map((friend) => (
                  <div
                    key={friend.user_id}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-[#1264A3] flex items-center justify-center text-white font-bold">
                        {(friend.display_name || friend.username).charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">
                          {friend.display_name || friend.username}
                        </p>
                        <p className="text-xs text-gray-500">@{friend.username}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => removeFriend(friend.user_id)}
                      className="text-gray-400 hover:text-red-500 p-1"
                      title="删除好友"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : (
            // 添加好友
            <div>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  通过用户ID或用户名搜索
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="输入用户ID或用户名"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
                    onKeyDown={(e) => e.key === "Enter" && searchUsers()}
                  />
                  <button
                    onClick={searchUsers}
                    disabled={searching || !searchQuery.trim()}
                    className="px-4 py-2 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0f5a94] disabled:opacity-50"
                  >
                    {searching ? "搜索中..." : "搜索"}
                  </button>
                </div>
              </div>

              {/* 搜索结果 */}
              {searchResults.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 mb-2">搜索结果：</p>
                  {searchResults.map((user) => (
                    <div
                      key={user.user_id}
                      className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-green-500 flex items-center justify-center text-white font-bold">
                          {(user.display_name || user.username).charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">
                            {user.display_name || user.username}
                          </p>
                          <p className="text-xs text-gray-500">@{user.username}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => addFriend(user.user_id)}
                        className="px-3 py-1.5 bg-[#007a5a] text-white rounded text-sm font-medium hover:bg-[#006a4d]"
                      >
                        添加
                      </button>
                    </div>
                  ))}
                </div>
              ) : searchQuery.trim() && !searching ? (
                <div className="text-center py-6 text-gray-500">
                  <p>未找到匹配的用户</p>
                  <p className="text-xs mt-1">可以尝试使用精确的用户ID搜索</p>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
