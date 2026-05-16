import { useState } from "react";
import type { MemberItem } from "../../../types";
import {
  MemberAvatar,
  MemberKindBadge,
  MemberPresenceBadge,
  MemberRow,
  MemberSection,
  resolveMemberKind,
  resolveMemberLabel,
  sortMembersByKind,
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

  const sortedMembers = sortMembersByKind(members, currentUserId);
  const bots = sortedMembers.filter((m) => resolveMemberKind(m) === "bot");
  const users = sortedMembers.filter((m) => resolveMemberKind(m) !== "bot");

  if (selected) {
    const kind = resolveMemberKind(selected);
    const isBot = kind === "bot";
    const isSelf = Boolean(currentUserId && selected.member_id === currentUserId && !isBot);
    const label = resolveMemberLabel(selected, kind);
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
            <MemberAvatar
              avatarUrl={selected.avatar_url}
              className="an-av"
              kind={kind}
              label={label}
              size={44}
            />
            <div className="an-info">
              <div className="an-n">
                {label}
                <MemberKindBadge kind={kind} />
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
                <div className="py-3 text-xs" style={{ color: "var(--fg-3)" }}>
                  加载中…
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    value={profileNickname}
                    onChange={(e) => onProfileNicknameChange(e.target.value)}
                    placeholder="频道昵称"
                    maxLength={64}
                    className="an-input"
                  />
                  <textarea
                    value={profileBio}
                    onChange={(e) => onProfileBioChange(e.target.value)}
                    placeholder="在本频道的身份介绍…"
                    rows={3}
                    className="an-textarea"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={onSaveMyProfile}
                      disabled={profileSaving}
                      className="an-btn an-btn-primary an-btn-sm"
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
          <MemberSection title="Agents · 智能体" count={bots.length}>
            {bots.map((m) => (
              <MemberRow
                key={m.member_id}
                as="button"
                member={m}
                onClick={() => setSelected(m)}
                badge={(
                  <>
                    <MemberKindBadge kind="bot" />
                    <MemberPresenceBadge member={m} />
                  </>
                )}
                action={<span className="an-member-chev" aria-hidden="true">›</span>}
              />
            ))}
          </MemberSection>
        )}
        {users.length > 0 && (
          <MemberSection title="People · 成员" count={users.length}>
            {users.map((m) => {
              const isSelf = Boolean(currentUserId && m.member_id === currentUserId);
              return (
                <MemberRow
                  key={m.member_id}
                  as="button"
                  member={m}
                  onClick={() => setSelected(m)}
                  badge={(
                    <>
                      {isSelf ? (
                        <span className="an-member-badge" data-tone="accent">我</span>
                      ) : (
                        <MemberKindBadge kind="user" />
                      )}
                      <MemberPresenceBadge member={m} />
                    </>
                  )}
                  title={isSelf ? "我的频道资料" : undefined}
                  action={<span className="an-member-chev" aria-hidden="true">›</span>}
                />
              );
            })}
          </MemberSection>
        )}
      </div>
    </div>
  );
}
