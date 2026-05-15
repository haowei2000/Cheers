import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../api";
import type { SearchResultType, SearchSelection } from "../types";
import { SearchPicker } from "./SearchPicker";

type ApiEnvelope<T> = { status?: string; data?: T; detail?: string; message?: string };

async function parseEnvelope<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok || data.status === "error") {
    throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  }
  return (data.data ?? data) as T;
}

function selectionKey(selection: SearchSelection) {
  if (selection.type === "user") return `user:${selection.item.user_id}`;
  if (selection.type === "bot") return `bot:${selection.item.bot_id}`;
  return "";
}

export function InviteMemberSearch({
  channelId,
  userToken,
  canInviteMembers,
  canAddBots,
  onInvited,
  className = "",
}: {
  channelId: string;
  userToken?: string | null;
  members: { member_id: string }[];
  canInviteMembers: boolean;
  canAddBots: boolean;
  onInvited: () => void;
  className?: string;
}) {
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const hasInvitePermission = canInviteMembers || canAddBots;
  const placeholder = canInviteMembers && canAddBots
    ? "搜索成员或 Bot"
    : canInviteMembers
      ? "搜索成员"
      : canAddBots
        ? "搜索 Bot"
        : "当前仅管理员可邀请";
  const types = useMemo<SearchResultType[]>(() => {
    const next: SearchResultType[] = [];
    if (canInviteMembers) next.push("users");
    if (canAddBots) next.push("bots");
    return next;
  }, [canAddBots, canInviteMembers]);

  const submitSelection = async (selection: SearchSelection) => {
    if (!hasInvitePermission || submittingKey) return;
    if (selection.type !== "user" && selection.type !== "bot") return;
    if (selection.type === "user" && !canInviteMembers) return;
    if (selection.type === "bot" && !canAddBots) return;

    const key = selectionKey(selection);
    setSubmittingKey(key);
    try {
      await parseEnvelope<unknown>(
        await apiFetch(`/channels/${channelId}/members`, {
          method: "POST",
          token: userToken,
          body: {
            member_id: selection.type === "user" ? selection.item.user_id : selection.item.bot_id,
            member_type: selection.type,
          },
        }),
      );
      toast.success(selection.type === "bot" ? "Bot 已加入频道" : "成员已邀请");
      onInvited();
    } catch (err) {
      toast.error((err as Error).message || "邀请失败");
    } finally {
      setSubmittingKey(null);
    }
  };

  if (!hasInvitePermission) {
    return (
      <div className={`an-search in-modal ${className}`} style={{ margin: 0 }}>
        <span className="an-search-ico">⌕</span>
        <input disabled placeholder={placeholder} aria-label={placeholder} />
      </div>
    );
  }

  return (
    <SearchPicker
      context="channel_invite"
      token={userToken}
      channelId={channelId}
      types={types}
      limit={8}
      modal
      className={className}
      placeholder={placeholder}
      emptyText={canInviteMembers ? "没有可邀请的成员或 Bot" : "没有可添加的 Bot"}
      actionLabel={(selection) => {
        if (selection.type !== "user" && selection.type !== "bot") return null;
        if (selection.type === "user" && !canInviteMembers) return null;
        if (selection.type === "bot" && !canAddBots) return null;
        return submittingKey === selectionKey(selection)
          ? "邀请中"
          : selection.type === "bot"
            ? "添加"
            : "邀请";
      }}
      onSelect={submitSelection}
    />
  );
}
