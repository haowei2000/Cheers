/* ThreadPanel — right-docked thread overlay inside the chat column.
 *
 * Wraps a root message + its reply chain (derived from in_reply_to) as its
 * own focused view. "Open as page ↗" promotes it to the full-page view
 * owned by App.tsx. */
import type { ChannelBot, ChannelUser, Message } from "../types";
import { stripThinkTags } from "../lib/think";
import { MessageMarkdown } from "../MessageMarkdown";
import { ThreadComposer } from "./ThreadComposer";

export interface ThreadPanelProps {
  rootMsg: Message;
  replies: Message[];
  channelBots: ChannelBot[];
  channelUsers: ChannelUser[];
  currentUserId: string;
  onClose: () => void;
  onOpenAsPage: () => void;
  onJumpToParent?: () => void;
  onSendReply: (text: string) => Promise<void> | void;
}

function resolveWhoLabel(
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

function shortTime(iso: string | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function ThreadPanel({
  rootMsg,
  replies,
  channelBots,
  channelUsers,
  currentUserId,
  onClose,
  onOpenAsPage,
  onJumpToParent,
  onSendReply,
}: ThreadPanelProps) {
  const titleSource = rootMsg.content || "(空消息)";
  const title = stripThinkTags(titleSource)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "对话串";

  return (
    <aside className="an-thread-panel" role="complementary" aria-label="Thread">
      <div className="an-tp-head">
        <div className="min-w-0 flex-1">
          <div className="an-tp-t truncate">{title}</div>
          <div className="an-tp-sub">
            {replies.length} 条回复 · 对话串
          </div>
        </div>
        <button
          type="button"
          className="an-tp-pop"
          onClick={onOpenAsPage}
          title="打开独立页面"
        >
          <svg
            viewBox="0 0 12 12"
            width="10"
            height="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M4 2H2v8h8V8" strokeLinecap="round" />
            <path d="M7 2h3v3M10 2L6 6" strokeLinecap="round" />
          </svg>
          Open as page
        </button>
        <button
          type="button"
          className="an-tp-x"
          onClick={onClose}
          aria-label="关闭对话串"
          title="关闭"
        >
          ✕
        </button>
      </div>
      <div className="an-tp-parent">
        <div className="an-pw">原始消息</div>
        <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
          <b style={{ color: "var(--fg-1)", fontWeight: 600 }}>
            {resolveWhoLabel(rootMsg, channelBots, channelUsers, currentUserId)}
          </b>{" "}
          <span style={{ color: "var(--fg-3)" }}>
            {shortTime(rootMsg.created_at)}
          </span>
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--fg-2)",
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          <MessageMarkdown text={stripThinkTags(rootMsg.content || "")} />
        </div>
        {onJumpToParent && (
          <button
            type="button"
            className="an-pm-jump"
            onClick={onJumpToParent}
            style={{ marginTop: 6 }}
          >
            跳转到原始消息 ↗
          </button>
        )}
      </div>
      <div className="an-tp-body">
        {replies.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: "var(--fg-3)",
              textAlign: "center",
              padding: "24px 8px",
            }}
          >
            还没有回复。是第一条？
          </div>
        ) : (
          replies.map((r) => (
            <div key={r.msg_id} className="an-tp-reply">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    marginBottom: 2,
                  }}
                >
                  <span className="an-who">
                    {resolveWhoLabel(
                      r,
                      channelBots,
                      channelUsers,
                      currentUserId,
                    )}
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
                  <span className="an-t">{shortTime(r.created_at)}</span>
                </div>
                <div className="an-c">
                  <MessageMarkdown text={stripThinkTags(r.content || "")} />
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="an-tp-foot">
        <ThreadComposer
          placeholder={`回复 "${title}"…`}
          channelBots={channelBots}
          channelUsers={channelUsers}
          onSend={onSendReply}
        />
      </div>
    </aside>
  );
}
