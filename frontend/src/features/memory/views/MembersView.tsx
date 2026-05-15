import { useState } from "react";
import type { MemberItem } from "../../../types";
import {
  MemberListItem,
  MemberPresenceBadge,
  colorForIdentity,
  initialsForIdentity,
} from "../../../components/members";

export function MembersView({
  members,
  currentUserId,
  profileLoading,
  profileNickname,
  profileBio,
  profileSaving,
  onProfileNicknameChange,
  onProfileBioChange,
  onSaveMyProfile,
}: {
  members: MemberItem[];
  currentUserId?: string | null;
  profileLoading: boolean;
  profileNickname: string;
  profileBio: string;
  profileSaving: boolean;
  onProfileNicknameChange: (value: string) => void;
  onProfileBioChange: (value: string) => void;
  onSaveMyProfile: () => void;
}) {
  const [selected, setSelected] = useState<MemberItem | null>(null);

  const bots = members.filter((m) => m.member_type === "bot");
  const users = members
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => member.member_type !== "bot")
    .sort((a, b) => {
      const aSelf = Boolean(currentUserId && a.member.member_id === currentUserId);
      const bSelf = Boolean(currentUserId && b.member.member_id === currentUserId);
      if (aSelf !== bSelf) return aSelf ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ member }) => member);

  if (selected) {
    const isBot = selected.member_type === "bot";
    const isSelf = Boolean(currentUserId && selected.member_id === currentUserId && !isBot);
    const label =
      selected.display_name ||
      selected.username ||
      (isBot ? "Bot" : "用户");
    const color = colorForIdentity(selected.member_id);
    return (
      <div className="overflow-y-auto px-3 py-2">
        <div className="an-mem-detail">
          <button
            type="button"
            className="an-md-back"
            onClick={() => setSelected(null)}
          >
            ← 返回成员列表
          </button>
          <div className="an-md-head">
            <div
              className="an-av"
              style={{ background: color, borderRadius: isBot ? 9 : 999 }}
            >
              {initialsForIdentity(label)}
            </div>
            <div className="an-info">
              <div className="an-n">
                {label}
                <span
                  className={
                    "an-tag-pill" + (isBot ? "" : "")
                  }
                  style={{
                    fontSize: 8.5,
                    fontWeight: 700,
                    letterSpacing: "0.7px",
                    padding: "1px 5px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    textTransform: "uppercase",
                    color: isBot ? "var(--fg-3)" : "var(--accent)",
                    background: isBot
                      ? "var(--surface-soft)"
                      : "var(--accent-muted)",
                  }}
                >
                  {isBot ? "BOT" : "USER"}
                </span>
                <MemberPresenceBadge member={selected} />
              </div>
              <div className="an-h">
                {selected.username && (
                  <span className="an-d">@{selected.username}</span>
                )}
                {selected.username && (
                  <span className="an-dot-sep">·</span>
                )}
                <span>{isBot ? "channel agent" : "channel member"}</span>
              </div>
            </div>
          </div>

          {isSelf ? (
            <div className="an-md-section">
              <div className="an-lbl">我的频道资料</div>
              {profileLoading ? (
                <div className="text-xs text-gray-400 py-3">加载中…</div>
              ) : (
                <div className="space-y-2">
                  <input
                    value={profileNickname}
                    onChange={(e) => onProfileNicknameChange(e.target.value)}
                    placeholder="频道昵称"
                    maxLength={64}
                    className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
                  />
                  <textarea
                    value={profileBio}
                    onChange={(e) => onProfileBioChange(e.target.value)}
                    placeholder="在本频道的身份介绍…"
                    rows={3}
                    className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={onSaveMyProfile}
                      disabled={profileSaving}
                      className="text-[11px] px-2.5 py-1 rounded bg-[#1264A3] text-white hover:bg-[#0f5a94] disabled:opacity-50"
                    >
                      {profileSaving ? "保存中…" : "保存资料"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="an-md-section">
              <div className="an-lbl">简介 · About</div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--fg-2)",
                  lineHeight: 1.5,
                }}
              >
                {isBot
                  ? "本频道的智能体，协同其他成员完成任务。"
                  : "本频道的用户成员。"}
              </div>
            </div>
          )}

          <div className="an-md-section">
            <div className="an-lbl">资料 · Profile</div>
            <div className="an-md-kv">
              <div className="an-k">ID</div>
              <div className="an-v" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                {selected.member_id}
              </div>
              <div className="an-k">类型</div>
              <div className="an-v">{isBot ? "Bot 智能体" : "人类成员"}</div>
              {selected.username && (
                <>
                  <div className="an-k">用户名</div>
                  <div className="an-v">@{selected.username}</div>
                </>
              )}
              {selected.display_name && (
                <>
                  <div className="an-k">显示名</div>
                  <div className="an-v">{selected.display_name}</div>
                </>
              )}
            </div>
          </div>

          <div className="an-md-actions">
            <button type="button">私聊</button>
            <button type="button">{isBot ? "查看日志" : "资料卡"}</button>
            <button type="button" className="primary">
              @ 提及
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="an-members-list min-h-0 flex-1 overflow-y-auto">
        {bots.length > 0 && (
          <>
            <div className="an-mem-group">
              <span>Agents · 智能体</span>
              <span className="an-ct">{bots.length}</span>
            </div>
            {bots.map((m) => {
              const label = m.display_name || m.username || "Bot";
              return (
                <MemberListItem
                  key={m.member_id}
                  id={m.member_id}
                  kind="bot"
                  username={m.username}
                  displayName={label}
                  avatarUrl={m.avatar_url}
                  variant="panel"
                  badges={<MemberPresenceBadge member={m} />}
                  onClick={() => setSelected(m)}
                />
              );
            })}
          </>
        )}
        {users.length > 0 && (
          <>
            <div className="an-mem-group">
              <span>People · 成员</span>
              <span className="an-ct">{users.length}</span>
            </div>
            {users.map((m) => {
              const label = m.display_name || m.username || "用户";
              const isSelf = Boolean(currentUserId && m.member_id === currentUserId);
              return (
                <MemberListItem
                  key={m.member_id}
                  id={m.member_id}
                  kind="user"
                  username={m.username}
                  displayName={label}
                  avatarUrl={m.avatar_url}
                  variant="panel"
                  self={isSelf}
                  badges={<MemberPresenceBadge member={m} />}
                  onClick={() => setSelected(m)}
                  title={isSelf ? "我的频道资料" : undefined}
                  aria-label={isSelf ? "我的频道资料" : label}
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
