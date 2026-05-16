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
    ? "Search members or bots"
    : canInviteMembers
      ? "Search members"
      : canAddBots
        ? "Search bots"
        : "Only admins can invite right now";
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
      toast.success(selection.type === "bot" ? "Bot added to channel" : "Member invited");
      onInvited();
    } catch (err) {
      toast.error((err as Error).message || "Invite failed");
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
      emptyText={canInviteMembers ? "No members or bots available to invite" : "No bots available to add"}
      actionLabel={(selection) => {
        if (selection.type !== "user" && selection.type !== "bot") return null;
        if (selection.type === "user" && !canInviteMembers) return null;
        if (selection.type === "bot" && !canAddBots) return null;
        return submittingKey === selectionKey(selection)
          ? "Inviting"
          : selection.type === "bot"
            ? "Add"
            : "Invite";
      }}
      onSelect={submitSelection}
    />
  );
}
