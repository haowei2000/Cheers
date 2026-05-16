/* TopicPage — full-page topic view (displayed in place of the chat stream
 * when App's pageTopicId is set, synced to URL hash #topic=<msg_id>). */
import { useMemo, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import type { Channel, ChannelBot, ChannelUser, Message } from "../types";
import { stripThinkTags } from "../lib/think";
import { ChatMessageRenderer } from "./ChatMessageRenderer";
import { AvatarVisual } from "./AvatarVisual";
import { BotAvatar } from "./BotAvatar";
import { AppIcon } from "./icons/AppIcon";
import { TopicComposer } from "./TopicComposer";
import type {
  ComposerKeychainItem,
  ComposerPendingFile,
} from "./MessageComposer";

export interface TopicPageProps {
  rootMsg: Message;
  replies: Message[];
  channel: Channel | null;
  channelBots: ChannelBot[];
  channelUsers: ChannelUser[];
  currentUserId: string;
  onBack: () => void;
  onGoToChannel?: () => void;
  onSendReply: (text: string, inReplyToMsgId?: string) => Promise<void> | void;
  onCopyMessage?: (message: Message) => Promise<void> | void;
  onForwardMessage?: (message: Message) => void;
  onToggleForwardSelection?: (message: Message) => void;
  forwardSelectionMode?: boolean;
  selectedForwardMsgIds?: string[];
  onShowMessageDetails?: (message: Message) => void;
  hasMessageDetails?: (message: Message) => boolean;
  onImageClick?: (src: string) => void;
  onFileClick?: (url: string, filename: string) => void;
  renderAttachments?: (message: Message) => ReactNode;
  pendingFiles?: ComposerPendingFile[];
  onRemovePendingFile?: (index: number) => void;
  onUploadFile?: (event: ChangeEvent<HTMLInputElement>) => void;
  keychainEnabled?: boolean;
  keychainOpen?: boolean;
  keychainLoading?: boolean;
  keychainItems?: ComposerKeychainItem[];
  onToggleKeychain?: () => void;
  onCloseKeychain?: () => void;
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
  if (m.sender_id === currentUserId) return "Me";
  const user = users.find((u) => u.member_id === m.sender_id);
  return user?.display_name || user?.username || "User";
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
  onCopyMessage,
  onForwardMessage,
  onToggleForwardSelection,
  forwardSelectionMode = false,
  selectedForwardMsgIds = [],
  onShowMessageDetails,
  hasMessageDetails,
  onImageClick,
  onFileClick,
  renderAttachments,
  pendingFiles,
  onRemovePendingFile,
  onUploadFile,
  keychainEnabled,
  keychainOpen,
  keychainLoading,
  keychainItems,
  onToggleKeychain,
  onCloseKeychain,
  sessionPanel,
}: TopicPageProps) {
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const messageById = useMemo(() => {
    const items = [rootMsg, ...replies];
    return new Map(items.map((item) => [item.msg_id, item]));
  }, [replies, rootMsg]);

  const title =
    stripThinkTags(rootMsg.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Topics";

  const previewMessage = (m: Message): string =>
    stripThinkTags(m.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "(No content)";

  const renderForwardActions = (m: Message) => {
    if (!onForwardMessage && !onToggleForwardSelection) return null;
    const selected = selectedForwardMsgIds.includes(m.msg_id);
    return (
      <>
        {onToggleForwardSelection && (
          <button
            type="button"
            title={selected ? "Cancel selection" : "Select for combined forward"}
            aria-label={selected ? "Cancel selection" : "Select for combined forward"}
            onClick={() => onToggleForwardSelection(m)}
            className="an-chat-action"
            style={
              selected
                ? { background: "var(--accent-muted)", color: "var(--accent)" }
                : undefined
            }
          >
            <AppIcon
              name={selected ? "checkCircle" : "check"}
              className="w-3.5 h-3.5"
            />
          </button>
        )}
        {onForwardMessage && (
          <button
            type="button"
            title="Forward"
            aria-label="Forward"
            onClick={() => onForwardMessage(m)}
            className="an-chat-action"
          >
            <AppIcon name="forward" className="w-3.5 h-3.5" />
          </button>
        )}
      </>
    );
  };

  const highlightMessage = (msgId: string) => {
    const el = document.getElementById(`msg-${msgId}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const origT = el.style.transition;
    const prevBg = el.style.background;
    el.style.transition = "background 200ms";
    el.style.background = "var(--accent-muted)";
    setTimeout(() => {
      el.style.background = prevBg;
      el.style.transition = origT;
    }, 1200);
  };

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
    const initial = isOwn ? "Me" : label.slice(0, 1).toUpperCase();
    const msgTitle =
      typeof m.content_data?.title === "string" ? m.content_data.title : null;
    const directParent =
      m.in_reply_to_msg_id && m.in_reply_to_msg_id !== rootMsg.msg_id
        ? messageById.get(m.in_reply_to_msg_id) ?? null
        : null;

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
                brandName={bot?.display_name || bot?.username || label}
                size={36}
                className="mt-0.5"
              />
            ) : (
              <AvatarVisual
                avatarUrl={avatarUrl}
                background={isOwn ? "var(--accent)" : "var(--fg-3)"}
                className="mt-0.5"
                fallback={initial}
                label={label}
                radius={12}
                size={36}
              />
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
            {directParent ? (
              <button
                type="button"
                className="an-reply-quote"
                title="Jump to replied message"
                onClick={() => highlightMessage(directParent.msg_id)}
              >
                <span className="an-rq-arrow">↪</span>
                <span className="an-rq-name">
                  {resolveWho(
                    directParent,
                    channelBots,
                    channelUsers,
                    currentUserId,
                  )}
                </span>
                <span className="an-rq-snip">{previewMessage(directParent)}</span>
              </button>
            ) : null}
            <div
              style={{
                fontSize: "var(--fs-chat-body)",
                lineHeight: "var(--lh-chat-body)",
                color: "var(--fg-1)",
                wordWrap: "break-word",
              }}
            >
              <ChatMessageRenderer
                attachments={renderAttachments?.(m)}
                collapseKey={m.msg_id}
                content={stripThinkTags(m.content || "")}
                onImageClick={onImageClick}
                onFileClick={onFileClick}
              />
            </div>
          </div>
          <div className={`${forwardSelectionMode ? "opacity-100" : "opacity-0 group-hover:opacity-100"} focus-within:opacity-100 transition-opacity self-start flex items-center gap-1 flex-shrink-0`}>
            {onShowMessageDetails && hasMessageDetails?.(m) && (
              <button
                type="button"
                title="View memory and streaming events for this AI reply"
                aria-label="View memory and streaming events for this AI reply"
                onClick={() => onShowMessageDetails(m)}
                className="an-chat-action"
              >
                <AppIcon name="help" className="w-3.5 h-3.5" />
              </button>
            )}
            {onCopyMessage && (
              <button
                type="button"
                title="Copy message content"
                aria-label="Copy message content"
                onClick={() => void onCopyMessage(m)}
                className="an-chat-action"
              >
                <AppIcon name="copy" className="w-3.5 h-3.5" />
              </button>
            )}
            {renderForwardActions(m)}
            <button
              type="button"
              title="Reply"
              aria-label="Reply"
              onClick={() => setReplyingTo(m)}
              className="an-chat-action"
            >
              <AppIcon name="reply" className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="an-topic-page">
      <div className="an-tpp-top">
        <button type="button" className="an-tpp-back" onClick={onBack}>
          ← Back to channel
        </button>
        <div className="an-tpp-meta">
          <div className="an-tpp-crumbs">
            {channel && onGoToChannel ? (
              <a onClick={onGoToChannel}>#{channel.name}</a>
            ) : (
              <span>Channels</span>
            )}
            <span className="an-sep">›</span>
            <span>Topics</span>
          </div>
          <div className="an-tpp-title">{title}</div>
          <div className="an-tpp-sub">
            <span>
              {replies.length} replies
            </span>
            <span className="an-d" />
            <span>
              Started by{" "}
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
        {sessionPanel && (
          <div className="an-tpp-actions">
            {sessionPanel}
          </div>
        )}
      </div>
      <div className="an-tpp-body">
        {renderTopicMessage(rootMsg)}

        <div className="an-tpp-divider">
          {replies.length} replies
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
            No replies yet. Send the first one below.
          </div>
        ) : (
          replies.map((r) => renderTopicMessage(r))
        )}
      </div>
      <div className="an-tpp-foot">
        <div className="an-wrap">
          <TopicComposer
            placeholder={`Reply "${title}"...`}
            channelBots={channelBots}
            channelUsers={channelUsers}
            currentUserId={currentUserId}
            onSend={async (text) => {
              await onSendReply(text, replyingTo?.msg_id ?? rootMsg.msg_id);
              setReplyingTo(null);
            }}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
            pendingFiles={pendingFiles}
            onRemovePendingFile={onRemovePendingFile}
            onUploadFile={onUploadFile}
            keychainEnabled={keychainEnabled}
            keychainOpen={keychainOpen}
            keychainLoading={keychainLoading}
            keychainItems={keychainItems}
            onToggleKeychain={onToggleKeychain}
            onCloseKeychain={onCloseKeychain}
          />
        </div>
      </div>
    </div>
  );
}
