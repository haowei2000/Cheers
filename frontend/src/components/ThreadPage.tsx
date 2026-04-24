/* ThreadPage — full-page thread view (displayed in place of the chat stream
 * when App's pageThreadId is set, synced to URL hash #thread=<msg_id>). */
import { useState } from "react";
import type { Channel, ChannelBot, ChannelUser, Message } from "../types";
import { stripThinkTags } from "../lib/think";

export interface ThreadPageProps {
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

export function ThreadPage({
  rootMsg,
  replies,
  channel,
  channelBots,
  channelUsers,
  currentUserId,
  onBack,
  onGoToChannel,
  onSendReply,
}: ThreadPageProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const title =
    stripThinkTags(rootMsg.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "对话串";

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSendReply(text);
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="an-thread-page">
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
            <span>对话串</span>
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
            {stripThinkTags(rootMsg.content || "")}
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
              <div className="an-r-c">{stripThinkTags(r.content || "")}</div>
            </div>
          ))
        )}
      </div>
      <div className="an-tpp-foot">
        <div className="an-wrap">
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              background: "var(--bg-0)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "8px 12px",
            }}
          >
            <input
              placeholder={`回复 "${title}"…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              style={{
                flex: 1,
                background: "transparent",
                border: 0,
                outline: 0,
                color: "var(--fg-1)",
                fontFamily: "inherit",
                fontSize: 13,
              }}
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || sending}
              style={{
                fontFamily: "inherit",
                fontSize: 12,
                background: draft.trim()
                  ? "var(--accent)"
                  : "var(--surface-soft)",
                color: draft.trim() ? "#fff" : "var(--fg-3)",
                border: 0,
                padding: "6px 14px",
                borderRadius: 6,
                cursor: draft.trim() && !sending ? "pointer" : "default",
              }}
            >
              {sending ? "发送中…" : "回复"}
            </button>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              marginTop: 6,
            }}
          >
            在这里的回复只留在本对话串里。
          </div>
        </div>
      </div>
    </div>
  );
}
