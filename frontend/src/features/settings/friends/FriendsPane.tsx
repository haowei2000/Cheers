import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import { MemberListItem } from "../../../components/members";
import { SearchPicker } from "../../../components/SearchPicker";
import type { Friend } from "../../../types";
import {
  DangerButton,
  Field,
  PrimaryButton,
  inputCls,
} from "../shared/SettingsControls";

type FriendTab = "friends" | "incoming" | "outgoing" | "blocked";

export function FriendsPane({
  currentUserId,
  authToken,
  onOpenDM,
}: {
  currentUserId: string;
  authToken: string | null;
  onOpenDM?: (memberId: string, memberType: "user" | "bot") => void;
}) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<Friend[]>([]);
  const [outgoing, setOutgoing] = useState<Friend[]>([]);
  const [blocked, setBlocked] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(false);
  const [directId, setDirectId] = useState("");
  const [tab, setTab] = useState<FriendTab>("friends");

  const loadAll = async () => {
    if (!currentUserId) return;
    setLoading(true);
    try {
      const [friendsRes, incomingRes, outgoingRes, blockedRes] = await Promise.all([
        apiFetch("/friends", { token: authToken }),
        apiFetch("/friends/requests?box=incoming", { token: authToken }),
        apiFetch("/friends/requests?box=outgoing", { token: authToken }),
        apiFetch("/friends/blocked/list", { token: authToken }),
      ]);
      const [friendsData, incomingData, outgoingData, blockedData] = await Promise.all([
        friendsRes.json(),
        incomingRes.json(),
        outgoingRes.json(),
        blockedRes.json(),
      ]);
      if (friendsData?.status === "success") setFriends(friendsData.data || []);
      if (incomingData?.status === "success") setIncoming(incomingData.data || []);
      if (outgoingData?.status === "success") setOutgoing(outgoingData.data || []);
      if (blockedData?.status === "success") setBlocked(blockedData.data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  const addByIdentifier = async (id: string) => {
    if (!id || !currentUserId) return;
    try {
      const res = await apiFetch("/friends/requests", {
        method: "POST",
        token: authToken,
        body: { friend_identifier: id },
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success(data.message || "好友申请已发送");
        loadAll();
        setDirectId("");
      } else {
        toast.error(data?.detail || data?.message || "添加失败");
      }
    } catch {
      toast.error("添加失败");
    }
  };

  const resolveRequest = async (friendshipId: string, action: "accept" | "reject") => {
    try {
      const res = await apiFetch(`/friends/requests/${friendshipId}/${action}`, {
        method: "POST",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success(action === "accept" ? "已同意好友申请" : "已拒绝好友申请");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "操作失败");
      }
    } catch {
      toast.error("操作失败");
    }
  };

  const cancelRequest = async (friendshipId: string) => {
    try {
      const res = await apiFetch(`/friends/requests/${friendshipId}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已撤回好友申请");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "撤回失败");
      }
    } catch {
      toast.error("撤回失败");
    }
  };

  const removeFriend = async (friendId: string) => {
    if (!confirm("确定删除这个好友？")) return;
    try {
      const res = await apiFetch(`/friends/${friendId}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已删除");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "删除失败");
      }
    } catch {
      toast.error("删除失败");
    }
  };

  const blockFriend = async (friendId: string) => {
    if (!confirm("确定拉黑这个用户？")) return;
    try {
      const res = await apiFetch("/friends/blocked", {
        method: "POST",
        token: authToken,
        body: { friend_identifier: friendId },
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已拉黑");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "拉黑失败");
      }
    } catch {
      toast.error("拉黑失败");
    }
  };

  const unblockFriend = async (friendId: string) => {
    try {
      const res = await apiFetch(`/friends/blocked/${friendId}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已解除拉黑");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "解除失败");
      }
    } catch {
      toast.error("解除失败");
    }
  };

  const smallButton = (label: string, onClick: () => void, danger = false, disabled = false) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`an-btn an-btn-sm ${danger ? "an-btn-danger" : ""}`}
    >
      {label}
    </button>
  );

  const renderFriendActions = (f: Friend, mode: FriendTab) => {
    if (mode === "friends") {
      return (
        <>
          {smallButton("私信", () => onOpenDM?.(f.user_id, "user"))}
          {smallButton("拉黑", () => blockFriend(f.user_id), true)}
          <DangerButton onClick={() => removeFriend(f.user_id)}>移除</DangerButton>
        </>
      );
    }
    if (mode === "incoming" && f.friendship_id) {
      return (
        <>
          {smallButton("拒绝", () => resolveRequest(f.friendship_id!, "reject"), true)}
          {smallButton("同意", () => resolveRequest(f.friendship_id!, "accept"))}
        </>
      );
    }
    if (mode === "outgoing" && f.friendship_id) {
      return <DangerButton onClick={() => cancelRequest(f.friendship_id!)}>撤回</DangerButton>;
    }
    if (mode === "blocked") {
      return <PrimaryButton onClick={() => unblockFriend(f.user_id)}>解除</PrimaryButton>;
    }
    return null;
  };

  const renderPersonRow = (f: Friend, mode: FriendTab) => (
    <MemberListItem
      key={`${mode}-${f.friendship_id || f.user_id}`}
      id={f.user_id}
      kind="user"
      username={f.username}
      displayName={f.display_name}
      avatarUrl={f.avatar_url}
      variant="card"
      actions={renderFriendActions(f, mode)}
    />
  );

  const visibleRows =
    tab === "friends" ? friends : tab === "incoming" ? incoming : tab === "outgoing" ? outgoing : blocked;

  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">好友</div>
          <div className="an-pane-sub">
            {friends.length > 0 ? `共 ${friends.length} 位好友` : "暂无好友"}
          </div>
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">添加好友</div>
          <Field label="通过 UUID">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                value={directId}
                onChange={(e) => setDirectId(e.target.value)}
                placeholder="粘贴好友 UUID"
                className={inputCls}
                style={{ flex: 1, fontFamily: "ui-monospace, monospace" }}
                onKeyDown={(e) => e.key === "Enter" && addByIdentifier(directId.trim())}
              />
              <PrimaryButton onClick={() => addByIdentifier(directId.trim())} disabled={!directId.trim()}>
                发送申请
              </PrimaryButton>
            </div>
          </Field>
          <Field label="或通过用户名搜索">
            <SearchPicker
              context="add_friend"
              token={authToken}
              types={["users"]}
              modal
              placeholder="输入用户名"
              actionLabel="添加"
              onSelect={(selection) => {
                if (selection.type === "user") addByIdentifier(selection.item.user_id);
              }}
            />
          </Field>
        </div>

        <div className="an-seg" style={{ alignSelf: "flex-start", margin: "2px 0" }}>
          {[
            ["friends", `好友 ${friends.length}`],
            ["incoming", `收到 ${incoming.length}`],
            ["outgoing", `已发送 ${outgoing.length}`],
            ["blocked", `黑名单 ${blocked.length}`],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "on" : ""}
              onClick={() => setTab(id as FriendTab)}
            >
              {label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            加载中…
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            暂无内容
          </div>
        ) : (
          visibleRows.map((f) => renderPersonRow(f, tab))
        )}
      </div>
    </div>
  );
}
