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
        toast.success(data.message || "Friend request sent");
        loadAll();
        setDirectId("");
      } else {
        toast.error(data?.detail || data?.message || "Add failed");
      }
    } catch {
      toast.error("Add failed");
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
        toast.success(action === "accept" ? "Friend request accepted" : "Friend request rejected");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "Operation failed");
      }
    } catch {
      toast.error("Operation failed");
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
        toast.success("Friend request withdrawn");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "Withdraw failed");
      }
    } catch {
      toast.error("Withdraw failed");
    }
  };

  const removeFriend = async (friendId: string) => {
    if (!confirm("Delete this friend?")) return;
    try {
      const res = await apiFetch(`/friends/${friendId}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("Deleted");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "Delete failed");
      }
    } catch {
      toast.error("Delete failed");
    }
  };

  const blockFriend = async (friendId: string) => {
    if (!confirm("Block this user?")) return;
    try {
      const res = await apiFetch("/friends/blocked", {
        method: "POST",
        token: authToken,
        body: { friend_identifier: friendId },
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("Blocked");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "Block failed");
      }
    } catch {
      toast.error("Block failed");
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
        toast.success("Unblocked");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "Unblock failed");
      }
    } catch {
      toast.error("Unblock failed");
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
          {smallButton("DMs", () => onOpenDM?.(f.user_id, "user"))}
          {smallButton("Block", () => blockFriend(f.user_id), true)}
          <DangerButton onClick={() => removeFriend(f.user_id)}>Remove</DangerButton>
        </>
      );
    }
    if (mode === "incoming" && f.friendship_id) {
      return (
        <>
          {smallButton("Reject", () => resolveRequest(f.friendship_id!, "reject"), true)}
          {smallButton("Accept", () => resolveRequest(f.friendship_id!, "accept"))}
        </>
      );
    }
    if (mode === "outgoing" && f.friendship_id) {
      return <DangerButton onClick={() => cancelRequest(f.friendship_id!)}>Withdraw</DangerButton>;
    }
    if (mode === "blocked") {
      return <PrimaryButton onClick={() => unblockFriend(f.user_id)}>Unblock</PrimaryButton>;
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
          <div className="an-pane-title">Friends</div>
          <div className="an-pane-sub">
            {friends.length > 0 ? `Total ${friends.length} friends` : "No friends"}
          </div>
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">Add friend</div>
          <Field label="By UUID">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                value={directId}
                onChange={(e) => setDirectId(e.target.value)}
                placeholder="Paste friend UUID"
                className={inputCls}
                style={{ flex: 1, fontFamily: "ui-monospace, monospace" }}
                onKeyDown={(e) => e.key === "Enter" && addByIdentifier(directId.trim())}
              />
              <PrimaryButton onClick={() => addByIdentifier(directId.trim())} disabled={!directId.trim()}>
                Send request
              </PrimaryButton>
            </div>
          </Field>
          <Field label="Or search by username">
            <SearchPicker
              context="add_friend"
              token={authToken}
              types={["users"]}
              modal
              placeholder="Enter username"
              actionLabel="Add"
              onSelect={(selection) => {
                if (selection.type === "user") addByIdentifier(selection.item.user_id);
              }}
            />
          </Field>
        </div>

        <div className="an-seg" style={{ alignSelf: "flex-start", margin: "2px 0" }}>
          {[
            ["friends", `Friends ${friends.length}`],
            ["incoming", `Incoming ${incoming.length}`],
            ["outgoing", `Sent ${outgoing.length}`],
            ["blocked", `Blocked ${blocked.length}`],
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
            Loading...
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            No content
          </div>
        ) : (
          visibleRows.map((f) => renderPersonRow(f, tab))
        )}
      </div>
    </div>
  );
}
