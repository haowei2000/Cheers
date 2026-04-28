/* TopicPage — full-page topic view (displayed in place of the chat stream
 * when App's pageTopicId is set, synced to URL hash #topic=<msg_id>). */
import type { Channel, ChannelBot, ChannelUser, Message } from "../types";
import { stripThinkTags } from "../lib/think";
import { MessageMarkdown } from "../MessageMarkdown";
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
}

function resolveWho(
  m: Message,
  bots: ChannelBot[],
  users: ChannelUser[],
  currentUserId: string,
): string {
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
}: TopicPageProps) {
  const title =
    stripThinkTags(rootMsg.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "主题";

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
      <div className="an-tpp-body">
        <div className="an-tpp-parent-card">
          <div className="an-pw">原始消息</div>
          <div className="an-pm-head">
            <span className="an-pm-who">
              {resolveWho(rootMsg, channelBots, channelUsers, currentUserId)}
            </span>
            {rootMsg.created_at && (
              <span className="an-pm-t">{formatDateTime(rootMsg.created_at)}</span>
            )}
          </div>
          <div className="an-pm-c">
            <MessageMarkdown text={stripThinkTags(rootMsg.content || "")} />
          </div>
        </div>

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
          replies.map((r) => (
            <div key={r.msg_id} className="an-tpp-reply">
              <div className="an-r-head">
                <span className="an-r-who">
                  {resolveWho(r, channelBots, channelUsers, currentUserId)}
                </span>
                {r.sender_type === "bot" && (
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
                {r.created_at && (
                  <span className="an-r-t">{formatDateTime(r.created_at)}</span>
                )}
              </div>
              <div className="an-r-c">
                <MessageMarkdown text={stripThinkTags(r.content || "")} />
              </div>
            </div>
          ))
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
