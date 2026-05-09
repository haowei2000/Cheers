/* TopicPage — full-page topic view (displayed in place of the chat stream
 * when App's pageTopicId is set, synced to URL hash #topic=<msg_id>). */
import type { ReactNode } from "react";
import type { Channel, ChannelBot, ChannelUser, Message } from "../types";
import { stripThinkTags } from "../lib/think";
import { MessageMarkdown } from "../MessageMarkdown";
import { BotAvatar } from "./BotAvatar";
import { TopicComposer } from "./TopicComposer";

export interface TopicPageProps {
  rootMsg: Message;
  replies: Message[];
  channel: Channel | null;
  channelBots: ChannelBot[];
  channelUsers: ChannelUser[];
  currentUserId: string;
  onBack: () => void;
  onGoToChannel?: () => void;
  onSendReply: (text: string) => Promise<void> | void;
  sessionPanel?: ReactNode;
}

function resolveWho(
  m: Message,
  bots: ChannelBot[],
  users: ChannelUser[],
  currentUserId: string,
): string {
  if (m.sender_name) return m.sender_name;
  if (m.sender_type === "bot") {
    const bot = bots.find((b) => b.member_id === m.sender_id);
    return bot?.display_name || bot?.username || "Bot";
  }
  if (m.sender_id === currentUserId) return "我";
  const user = users.find((u) => u.member_id === m.sender_id);
  return user?.display_name || user?.username || "用户";
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  } catch {
    return "";
  }
}

export function TopicPage({
  rootMsg,
  replies,
  channel,
  channelBots,
  channelUsers,
  currentUserId,
  onBack,
  onGoToChannel,
  onSendReply,
  sessionPanel,
}: TopicPageProps) {
  const title =
    stripThinkTags(rootMsg.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "主题";

  const renderTopicMessage = (m: Message) => {
    const isBot = m.sender_type === "bot";
    const isOwn = m.sender_type === "user" && m.sender_id === currentUserId;
    const bot = isBot
      ? channelBots.find((b) => b.member_id === m.sender_id)
      : undefined;
    const user = !isBot
      ? channelUsers.find((u) => u.member_id === m.sender_id)
      : undefined;
    const label = resolveWho(m, channelBots, channelUsers, currentUserId);
    const avatarUrl = isBot ? bot?.avatar_url : user?.avatar_url;
    const initial = isOwn ? "我" : label.slice(0, 1).toUpperCase();
    const msgTitle =
      typeof m.content_data?.title === "string" ? m.content_data.title : null;

    return (
      <div
        key={m.msg_id}
        id={`msg-${m.msg_id}`}
        className="an-chat-msg group relative px-4 transition-colors"
        style={{ paddingTop: 8, paddingBottom: 2 }}
      >
        <div
          className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: "var(--surface-soft)" }}
        />
        <div className="relative flex gap-3">
          <div className="w-9 flex-shrink-0">
            {isBot ? (
              <BotAvatar
                label={label}
                avatarUrl={avatarUrl}
                size={36}
                className="mt-0.5"
              />
            ) : avatarUrl ? (
              <img
                src={avatarUrl}
                alt={label}
                className="w-9 h-9 rounded-xl object-cover select-none mt-0.5"
              />
            ) : (
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none mt-0.5"
                style={{
                  background: isOwn ? "var(--accent)" : "var(--fg-3)",
                }}
              >
                {initial}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
              <span
                className="font-semibold"
                style={{
                  fontSize: "var(--fs-chat-name)",
                  lineHeight: 1.2,
                  color: "var(--fg-1)",
                }}
              >
                {label}
              </span>
              {isBot && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.6px",
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "var(--surface-soft)",
                    color: "var(--fg-3)",
                    border: "1px solid var(--border)",
                  }}
                >
                  BOT
                </span>
              )}
              {m.created_at && (
                <span className="text-[11px]" style={{ color: "var(--fg-3)" }}>
                  {formatDateTime(m.created_at)}
                </span>
              )}
            </div>
            {msgTitle ? (
              <div
                className="text-[14px] font-semibold mb-1 leading-snug"
                style={{ color: "var(--fg-1)" }}
              >
                {msgTitle}
              </div>
            ) : null}
            <div
              style={{
                fontSize: "var(--fs-chat-body)",
                lineHeight: "var(--lh-chat-body)",
                color: "var(--fg-1)",
                wordWrap: "break-word",
              }}
            >
              <MessageMarkdown text={stripThinkTags(m.content || "")} />
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="an-topic-page">
      <div className="an-tpp-top">
        <button type="button" className="an-tpp-back" onClick={onBack}>
          ← 返回频道
        </button>
        <div className="an-tpp-meta">
          <div className="an-tpp-crumbs">
            {channel && onGoToChannel ? (
              <a onClick={onGoToChannel}>#{channel.name}</a>
            ) : (
              <span>频道</span>
            )}
            <span className="an-sep">›</span>
            <span>主题</span>
          </div>
          <div className="an-tpp-title">{title}</div>
          <div className="an-tpp-sub">
            <span>
              {replies.length} 条回复
            </span>
            <span className="an-d" />
            <span>
              发起人{" "}
              {resolveWho(rootMsg, channelBots, channelUsers, currentUserId)}
            </span>
            {rootMsg.created_at && (
              <>
                <span className="an-d" />
                <span>{formatDateTime(rootMsg.created_at)}</span>
              </>
            )}
          </div>
        </div>
      </div>
      {sessionPanel}
      <div className="an-tpp-body">
        {renderTopicMessage(rootMsg)}

        <div className="an-tpp-divider">
          {replies.length} 条回复
        </div>

        {replies.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              fontSize: 12,
              color: "var(--fg-3)",
              padding: "24px 8px",
            }}
          >
            还没有回复。在下方发送第一条。
          </div>
        ) : (
          replies.map((r) => renderTopicMessage(r))
        )}
      </div>
      <div className="an-tpp-foot">
        <div className="an-wrap">
          <TopicComposer
            placeholder={`回复 "${title}"…`}
            channelBots={channelBots}
            channelUsers={channelUsers}
            onSend={onSendReply}
            hint={
              <>
                <kbd>@</kbd> 提及 · <kbd>↵</kbd> 发送 · <kbd>⇧↵</kbd> 换行 ·
                在这里的回复只留在本主题里
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
