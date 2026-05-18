import {
  memo,
  useCallback,
  useMemo,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  type UIEvent,
} from "react";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import toast from "react-hot-toast";
import { AvatarVisual } from "../../../components/AvatarVisual";
import { BotAvatar } from "../../../components/BotAvatar";
import { ClarifyInlineBlock } from "../../../components/ClarifyInlineBlock";
import { ChatMessageRenderer } from "../../../components/ChatMessageRenderer";
import { AppIcon } from "../../../components/icons/AppIcon";
import { apiFetch } from "../../../api";
import { patchMessage, type MessageStore } from "../../../lib/message-store";
import { refreshDMs } from "../../../lib/refresh";
import type {
  AgentBridgeTaskContentData,
  Channel,
  ChannelBot,
  ChannelUser,
  ClarifyAnswers,
  ClarifySchema,
  CurrentUser,
  DM,
  Message,
} from "../../../types";
import { getSecretSecondsLeft, SecretMessageVeil } from "./SecretMessageVeil";
import {
  createMessageViewModel,
  type MessageRenderItem,
  type MessageViewModel,
} from "./renderModel";

const CHAT_TIME_CACHE_LIMIT = 2000;
const chatTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const chatReplyTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
});
const chatTimeCache = new Map<string, string>();

function formatChatTime(iso: string | undefined, compact = false): string {
  if (!iso) return "";
  const cacheKey = `${compact ? "compact" : "full"}:${iso}`;
  const cached = chatTimeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parsed = Date.parse(iso);
  const value = Number.isFinite(parsed)
    ? (compact ? chatReplyTimeFormatter : chatTimeFormatter).format(parsed)
    : "";
  chatTimeCache.set(cacheKey, value);
  if (chatTimeCache.size > CHAT_TIME_CACHE_LIMIT) {
    const oldest = chatTimeCache.keys().next().value;
    if (oldest) chatTimeCache.delete(oldest);
  }
  return value;
}

export interface ChatMessageListProps {
  messagesContainerRef: RefObject<HTMLDivElement>;
  inputRef: RefObject<HTMLTextAreaElement>;
  secretInputRef: RefObject<HTMLInputElement>;
  onMessagesScroll: (event: UIEvent<HTMLDivElement>) => void;
  loading: boolean;
  restoringInitialScroll: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  messages: Message[];
  selectedChannel: Channel | null;
  selectedId: string | null;
  isDmSelected: boolean;
  currentUser: CurrentUser;
  currentUserId: string | null;
  authToken: string | null;
  renderItems: MessageRenderItem[];
  virtualItems: VirtualItem[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  showJumpToBottom: boolean;
  onJumpToBottom: () => void;
  botById: Map<string, ChannelBot>;
  botByUsername: Map<string, ChannelBot>;
  coordinatorBot?: ChannelBot;
  userById: Map<string, ChannelUser>;
  revealedSecrets: Record<string, string>;
  secretTokens: Record<string, string>;
  clarifyAnsweredParentIds: Set<string>;
  pendingClarifyReplyMsgId: string | null;
  collapsedMessages: Set<string>;
  processingBots: Record<string, string>;
  secretMode: boolean;
  setMessageStore: Dispatch<SetStateAction<MessageStore>>;
  setDMs: Dispatch<SetStateAction<DM[]>>;
  setComposerInput: (value: string) => void;
  setReplyingTo: Dispatch<SetStateAction<Message | null>>;
  setPageTopicId: Dispatch<SetStateAction<string | null>>;
  revealSecretMessage: (msgId: string) => void;
  copyMessageText: (message: Message) => void;
  renderMemoryLoadButton: (message: Message) => ReactNode;
  renderStopStreamButton: (message: Message) => ReactNode;
  renderPartialBadge: (message: Message) => ReactNode;
  renderBotTraceStatus: (message: Message) => ReactNode;
  renderAgentBridgeTaskCard: (message: Message) => ReactNode;
  renderFileAttachments: (message: Message, alignRight?: boolean) => ReactNode;
  activeAgentBridgeTaskData: (message: Message) => AgentBridgeTaskContentData | null;
  handleMarkdownImageClick: (src: string) => void;
  handleMarkdownFileClick: (url: string, name: string) => void;
  handleClarifyContinue: (
    msgId: string,
    schema: ClarifySchema,
    answers: ClarifyAnswers,
  ) => void;
  handleClarifySkip: (msgId: string) => void;
  toggleTopic: (rootId: string) => void;
  toggleMessage: (msgId: string) => void;
  forwardSelectionMode?: boolean;
  renderForwardActionButtons?: (
    message: Message,
    actionClassName?: string,
    iconClassName?: string,
  ) => ReactNode;
}

type RowActionProps = {
  actionVisibilityClass: string;
  inputRef: RefObject<HTMLTextAreaElement>;
  secretInputRef: RefObject<HTMLInputElement>;
  secretMode: boolean;
  message: Message;
  senderBot?: ChannelBot;
  setComposerInput: (value: string) => void;
  setReplyingTo: Dispatch<SetStateAction<Message | null>>;
  copyMessageText: (message: Message) => void;
  renderMemoryLoadButton: (message: Message) => ReactNode;
  renderForwardActionButtons?: ChatMessageListProps["renderForwardActionButtons"];
  showReply: boolean;
  canDelete: boolean;
  onDeleteMessage: (message: Message) => void;
};

const RowActions = memo(function RowActions({
  actionVisibilityClass,
  inputRef,
  secretInputRef,
  secretMode,
  message,
  senderBot,
  setComposerInput,
  setReplyingTo,
  copyMessageText,
  renderMemoryLoadButton,
  renderForwardActionButtons,
  showReply,
  canDelete,
  onDeleteMessage,
}: RowActionProps) {
  if (message.is_deleted) return null;

  return (
    <div className={`${actionVisibilityClass} an-msg-actions self-start flex items-center gap-1 flex-shrink-0`}>
      <button
        type="button"
        title="Copy message content"
        onClick={() => copyMessageText(message)}
        className="an-chat-action"
      >
        <AppIcon name="copy" className="w-3.5 h-3.5" />
      </button>
      {renderForwardActionButtons?.(message)}
      {renderMemoryLoadButton(message)}
      {showReply && (
        <button
          type="button"
          title="Reply"
          onClick={() => {
            setReplyingTo(message);
            const mention =
              message.sender_type === "bot" && senderBot?.username
                ? `@${senderBot.username} `
                : "";
            if (mention) setComposerInput(mention);
            (secretMode ? secretInputRef.current : inputRef.current)?.focus();
          }}
          className="an-chat-action"
        >
          <AppIcon name="reply" className="w-3.5 h-3.5" />
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          title="Delete message"
          onClick={() => onDeleteMessage(message)}
          className="an-chat-action"
        >
          <AppIcon name="trash" className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
});

function MessageAvatar({
  vm,
  size,
  className,
}: {
  vm: MessageViewModel;
  size: 24 | 32 | 36;
  className?: string;
}) {
  if (vm.isBot) {
    return (
      <BotAvatar
        label={vm.senderLabel}
        avatarUrl={vm.senderBot?.avatar_url}
        brandName={vm.senderBot?.display_name || vm.senderBot?.username || vm.senderLabel}
        size={size}
        className={className}
      />
    );
  }
  if (vm.avatarUrl) {
    return (
      <img
        src={vm.avatarUrl}
        alt={vm.senderLabel}
        className={`${size === 36 ? "w-9 h-9" : size === 32 ? "w-8 h-8" : "w-6 h-6"} rounded-xl object-cover select-none ${className ?? ""}`}
      />
    );
  }
  return (
    <div
      className={`${size === 36 ? "an-chat-avatar lg" : size === 32 ? "an-chat-avatar md" : "an-chat-avatar sm"} ${className ?? ""}`}
      style={{ background: vm.isOwn ? "var(--accent)" : "var(--fg-3)" }}
    >
      {vm.isOwn ? "Me" : vm.initials}
    </div>
  );
}

type MessageBodyProps = {
  vm: MessageViewModel;
  selectedId: string | null;
  secretTokens: Record<string, string>;
  revealSecretMessage: (msgId: string) => void;
  activeAgentBridgeTaskData: (message: Message) => AgentBridgeTaskContentData | null;
  renderAgentBridgeTaskCard: (message: Message) => ReactNode;
  renderStopStreamButton: (message: Message) => ReactNode;
  renderPartialBadge: (message: Message) => ReactNode;
  renderBotTraceStatus: (message: Message) => ReactNode;
  handleMarkdownImageClick: (src: string) => void;
  handleMarkdownFileClick: (url: string, name: string) => void;
  handleClarifyContinue: ChatMessageListProps["handleClarifyContinue"];
  handleClarifySkip: (msgId: string) => void;
  compact?: boolean;
};

function MessageBody({
  vm,
  selectedId,
  secretTokens,
  revealSecretMessage,
  activeAgentBridgeTaskData,
  renderAgentBridgeTaskCard,
  renderStopStreamButton,
  renderPartialBadge,
  renderBotTraceStatus,
  handleMarkdownImageClick,
  handleMarkdownFileClick,
  handleClarifyContinue,
  handleClarifySkip,
  compact = false,
}: MessageBodyProps) {
  const message = vm.message;
  if (message.is_deleted) {
    return (
      <span className="an-chat-meta" style={{ fontStyle: "italic" }}>
        {vm.bodyContent}
      </span>
    );
  }

  const secretSecsLeft =
    message.is_secret && !vm.secretRevealedContent && message.created_at
      ? getSecretSecondsLeft(message.created_at)
      : null;
  const isSecretExpired = secretSecsLeft !== null && secretSecsLeft <= 0;
  const isSecretUnrevealed =
    Boolean(message.is_secret) && !vm.secretRevealedContent && !isSecretExpired;
  const taskData = activeAgentBridgeTaskData(message);
  const quote = vm.quote;

  return (
    <>
      {quote && !isSecretExpired && !isSecretUnrevealed && (
        <div className="an-reply-quote" title={`Reply ${quote.label}`}>
          <span className="an-rq-arrow">↪</span>
          <span className="an-rq-name">{quote.label}</span>
          <span className="an-rq-snip">
            {quote.quote.replace(/\s+/g, " ").trim()}
          </span>
        </div>
      )}
      {isSecretExpired || isSecretUnrevealed ? (
        <SecretMessageVeil
          createdAt={message.created_at}
          canReveal={Boolean(secretTokens[message.msg_id])}
          onReveal={() => revealSecretMessage(message.msg_id)}
        />
      ) : taskData ? (
        renderAgentBridgeTaskCard(message)
      ) : message._streaming && !vm.bodyContent ? (
        <span className="an-chat-typing-dot" />
      ) : (
        <ChatMessageRenderer
          collapseKey={message.msg_id}
          content={vm.bodyContent}
          keyPrefix={`${message.msg_id}-${compact ? "compact" : "body"}-`}
          streaming={Boolean(message._streaming)}
          showStreamingCursor={false}
          disableAutoCollapse={compact}
          onImageClick={handleMarkdownImageClick}
          onFileClick={handleMarkdownFileClick}
        />
      )}
      {message._streaming && Boolean(vm.bodyContent) && (
        <span className="an-chat-typing-dot slim" />
      )}
      {renderStopStreamButton(message)}
      {renderPartialBadge(message)}
      {renderBotTraceStatus(message)}
      {vm.clarifyStatus !== null && selectedId && vm.clarify && (
        <ClarifyInlineBlock
          msgId={message.msg_id}
          schema={vm.clarify}
          status={vm.clarifyStatus}
          replyContent={undefined}
          onContinue={(answers) =>
            handleClarifyContinue(message.msg_id, vm.clarify!, answers)
          }
          onSkip={() => handleClarifySkip(message.msg_id)}
        />
      )}
    </>
  );
}

type MessageRowProps = {
  item: Extract<MessageRenderItem, { kind: "message" | "inline-reply" | "topic-reply" }>;
  vm: MessageViewModel;
  selectedChannel: Channel | null;
  selectedId: string | null;
  isDmSelected: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  secretInputRef: RefObject<HTMLInputElement>;
  secretMode: boolean;
  secretTokens: Record<string, string>;
  renderFileAttachments: (message: Message, alignRight?: boolean) => ReactNode;
  revealSecretMessage: (msgId: string) => void;
  copyMessageText: (message: Message) => void;
  renderMemoryLoadButton: (message: Message) => ReactNode;
  renderStopStreamButton: (message: Message) => ReactNode;
  renderPartialBadge: (message: Message) => ReactNode;
  renderBotTraceStatus: (message: Message) => ReactNode;
  renderAgentBridgeTaskCard: (message: Message) => ReactNode;
  activeAgentBridgeTaskData: (message: Message) => AgentBridgeTaskContentData | null;
  handleMarkdownImageClick: (src: string) => void;
  handleMarkdownFileClick: (url: string, name: string) => void;
  handleClarifyContinue: ChatMessageListProps["handleClarifyContinue"];
  handleClarifySkip: (msgId: string) => void;
  setComposerInput: (value: string) => void;
  setReplyingTo: Dispatch<SetStateAction<Message | null>>;
  toggleMessage: (msgId: string) => void;
  collapsedMessages: Set<string>;
  renderForwardActionButtons?: ChatMessageListProps["renderForwardActionButtons"];
  forwardSelectionMode: boolean;
  canDelete: boolean;
  onDeleteMessage: (message: Message) => void;
};

const MessageRow = memo(function MessageRow({
  item,
  vm,
  selectedChannel,
  selectedId,
  isDmSelected,
  inputRef,
  secretInputRef,
  secretMode,
  secretTokens,
  renderFileAttachments,
  revealSecretMessage,
  copyMessageText,
  renderMemoryLoadButton,
  renderStopStreamButton,
  renderPartialBadge,
  renderBotTraceStatus,
  renderAgentBridgeTaskCard,
  activeAgentBridgeTaskData,
  handleMarkdownImageClick,
  handleMarkdownFileClick,
  handleClarifyContinue,
  handleClarifySkip,
  setComposerInput,
  setReplyingTo,
  toggleMessage,
  collapsedMessages,
  renderForwardActionButtons,
  forwardSelectionMode,
  canDelete,
  onDeleteMessage,
}: MessageRowProps) {
  const message = vm.message;
  const isTopicReply = item.kind === "topic-reply";
  const isInlineReply = item.kind === "inline-reply";
  const isReplyRow = isInlineReply || isTopicReply;
  const isDMRender = selectedChannel?.type === "dm";
  const showReply = !isDmSelected;
  const actionVisibilityClass = `${forwardSelectionMode ? "opacity-100" : "opacity-0 group-hover:opacity-100"} focus-within:opacity-100 transition-opacity`;
  const topicReplyCollapsed = isTopicReply && collapsedMessages.has(message.msg_id);
  const topicReplyPreview =
    vm.displayContent.replace(/\s+/g, " ").slice(0, 42) +
    (vm.displayContent.length > 42 ? "..." : "");

  if (isDMRender && vm.isOwn) {
    return (
      <div
        id={`msg-${message.msg_id}`}
        className="an-chat-msg group flex flex-row-reverse items-end gap-2.5 px-4 py-1 transition-all"
      >
        <MessageAvatar vm={vm} size={32} />
        <div className="an-dm-bubble-stack flex flex-col items-end max-w-[85%] sm:max-w-[72%]">
          <div className="flex items-baseline gap-1.5 mb-1 justify-end">
            <span className="an-chat-meta mr-0.5">{vm.time}</span>
          </div>
          {message.content_data?.title ? (
            <div className="an-chat-title mb-1 mr-0.5 text-right">
              {message.content_data.title as string}
            </div>
          ) : null}
          {!message.is_deleted && renderFileAttachments(message, true)}
          <div className="an-chat-bubble own">
            <MessageBody
              vm={vm}
              selectedId={selectedId}
              secretTokens={secretTokens}
              revealSecretMessage={revealSecretMessage}
              activeAgentBridgeTaskData={activeAgentBridgeTaskData}
              renderAgentBridgeTaskCard={renderAgentBridgeTaskCard}
              renderStopStreamButton={renderStopStreamButton}
              renderPartialBadge={renderPartialBadge}
              renderBotTraceStatus={renderBotTraceStatus}
              handleMarkdownImageClick={handleMarkdownImageClick}
              handleMarkdownFileClick={handleMarkdownFileClick}
              handleClarifyContinue={handleClarifyContinue}
              handleClarifySkip={handleClarifySkip}
            />
          </div>
        </div>
        <RowActions
          actionVisibilityClass={actionVisibilityClass}
          inputRef={inputRef}
          secretInputRef={secretInputRef}
          secretMode={secretMode}
          message={message}
          senderBot={vm.senderBot}
          setComposerInput={setComposerInput}
          setReplyingTo={setReplyingTo}
          copyMessageText={copyMessageText}
          renderMemoryLoadButton={renderMemoryLoadButton}
          renderForwardActionButtons={renderForwardActionButtons}
          showReply={showReply}
          canDelete={canDelete}
          onDeleteMessage={onDeleteMessage}
        />
      </div>
    );
  }

  if (isDMRender) {
    return (
      <div
        id={`msg-${message.msg_id}`}
        className="an-chat-msg group flex items-start gap-2.5 px-4 py-1 transition-all"
      >
        <MessageAvatar vm={vm} size={32} className="mt-0.5" />
        <div className="an-dm-bubble-stack flex flex-col max-w-[85%] sm:max-w-[72%]">
          <div className="flex items-baseline gap-1.5 mb-1">
            <span className="an-chat-sender">{vm.senderLabel}</span>
            {vm.isBot && <span className="an-chip green">Bot</span>}
            <span className="an-chat-meta">{vm.time}</span>
          </div>
          {message.content_data?.title ? (
            <div className="an-chat-title mb-1">{message.content_data.title as string}</div>
          ) : null}
          {!message.is_deleted && renderFileAttachments(message)}
          <div className="an-chat-bubble other">
            <MessageBody
              vm={vm}
              selectedId={selectedId}
              secretTokens={secretTokens}
              revealSecretMessage={revealSecretMessage}
              activeAgentBridgeTaskData={activeAgentBridgeTaskData}
              renderAgentBridgeTaskCard={renderAgentBridgeTaskCard}
              renderStopStreamButton={renderStopStreamButton}
              renderPartialBadge={renderPartialBadge}
              renderBotTraceStatus={renderBotTraceStatus}
              handleMarkdownImageClick={handleMarkdownImageClick}
              handleMarkdownFileClick={handleMarkdownFileClick}
              handleClarifyContinue={handleClarifyContinue}
              handleClarifySkip={handleClarifySkip}
            />
          </div>
        </div>
        <RowActions
          actionVisibilityClass={actionVisibilityClass}
          inputRef={inputRef}
          secretInputRef={secretInputRef}
          secretMode={secretMode}
          message={message}
          senderBot={vm.senderBot}
          setComposerInput={setComposerInput}
          setReplyingTo={setReplyingTo}
          copyMessageText={copyMessageText}
          renderMemoryLoadButton={renderMemoryLoadButton}
          renderForwardActionButtons={renderForwardActionButtons}
          showReply={showReply}
          canDelete={canDelete}
          onDeleteMessage={onDeleteMessage}
        />
      </div>
    );
  }

  return (
    <div
      id={`msg-${message.msg_id}`}
      className={`an-chat-msg group relative px-4 transition-colors ${isReplyRow ? "an-chat-reply-row" : ""}`}
      style={{ paddingTop: isReplyRow ? 4 : 8, paddingBottom: 2 }}
    >
      <div
        className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: "var(--surface-soft)" }}
      />
      <div className="relative flex gap-3">
        <div className="w-9 flex-shrink-0">
          <MessageAvatar vm={vm} size={36} className="mt-0.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
            <span className="an-chat-sender">{vm.isOwn ? "Me" : vm.senderLabel}</span>
            {vm.isBot && <span className="an-chip green">Bot</span>}
            <span className="an-chat-meta">{vm.time}</span>
            {topicReplyCollapsed && (
              <span className="an-chat-meta truncate max-w-[220px]">
                {topicReplyPreview}
              </span>
            )}
            {isTopicReply && (
              <button
                type="button"
                onClick={() => toggleMessage(message.msg_id)}
                className="an-chat-mini-action ml-0.5 opacity-0 group-hover:opacity-100"
                title={topicReplyCollapsed ? "Expand" : "Collapse"}
              >
                <AppIcon name={topicReplyCollapsed ? "chevronDown" : "chevronUp"} className="w-3 h-3" />
              </button>
            )}
          </div>
          {message.content_data?.title ? (
            <div className="an-chat-title mb-1">{message.content_data.title as string}</div>
          ) : null}
          {!topicReplyCollapsed && !message.is_deleted && renderFileAttachments(message)}
          {!topicReplyCollapsed && (
            <div className="an-chat-body">
              <MessageBody
                vm={vm}
                selectedId={selectedId}
                secretTokens={secretTokens}
                revealSecretMessage={revealSecretMessage}
                activeAgentBridgeTaskData={activeAgentBridgeTaskData}
                renderAgentBridgeTaskCard={renderAgentBridgeTaskCard}
                renderStopStreamButton={renderStopStreamButton}
                renderPartialBadge={renderPartialBadge}
                renderBotTraceStatus={renderBotTraceStatus}
                handleMarkdownImageClick={handleMarkdownImageClick}
                handleMarkdownFileClick={handleMarkdownFileClick}
                handleClarifyContinue={handleClarifyContinue}
                handleClarifySkip={handleClarifySkip}
              />
            </div>
          )}
        </div>
        <RowActions
          actionVisibilityClass={actionVisibilityClass}
          inputRef={inputRef}
          secretInputRef={secretInputRef}
          secretMode={secretMode}
          message={message}
          senderBot={vm.senderBot}
          setComposerInput={setComposerInput}
          setReplyingTo={setReplyingTo}
          copyMessageText={copyMessageText}
          renderMemoryLoadButton={renderMemoryLoadButton}
          renderForwardActionButtons={renderForwardActionButtons}
          showReply={showReply}
          canDelete={canDelete}
          onDeleteMessage={onDeleteMessage}
        />
      </div>
    </div>
  );
});

const RoutingRow = memo(function RoutingRow({
  message,
  coordinatorBot,
  botByUsername,
}: {
  message: Message;
  coordinatorBot?: ChannelBot;
  botByUsername: Map<string, ChannelBot>;
}) {
  const cd = (message.content_data ?? {}) as Record<string, unknown>;
  const q = typeof cd.q === "string" ? cd.q : null;
  const plan = typeof cd.plan === "string" ? cd.plan : null;
  const picksRaw = Array.isArray(cd.picks)
    ? (cd.picks as Array<Record<string, unknown>>)
    : [];
  const picks = picksRaw.map((pick) => ({
    agent: typeof pick.agent === "string" ? pick.agent : "agent",
    score: typeof pick.score === "string" ? pick.score : null,
    why: typeof pick.why === "string" ? pick.why : null,
    picked: pick.picked === true,
  }));
  return (
    <div id={`msg-${message.msg_id}`} className="an-chat-msg pl-16 pr-4 pt-2">
      <div className="flex items-baseline gap-1.5 mb-1 pl-1">
        <span className="an-chat-sender">
          {coordinatorBot?.display_name || coordinatorBot?.username || "Assistant"}
        </span>
        <span className="an-chip accent">COORDINATOR</span>
        {message.created_at && (
          <span className="an-chat-meta">{formatChatTime(message.created_at)}</span>
        )}
      </div>
      <div className="an-routing">
        {q && <div className="an-rq">Route: <b>{q}</b></div>}
        {picks.length > 0 && (
          <div className="an-picks">
            {picks.map((pick) => {
              const bot = botByUsername.get(pick.agent);
              return (
                <span
                  key={pick.agent}
                  className={`an-pick${pick.picked ? " picked" : ""}`}
                  title={pick.why || undefined}
                >
                  <span
                    className="an-dot"
                    style={{ background: bot?.avatar_url ? "var(--accent)" : "var(--fg-3)" }}
                  />
                  @{pick.agent}
                  {pick.score && <span className="an-type-caption ml-0.5">{pick.score}</span>}
                </span>
              );
            })}
          </div>
        )}
        {plan && <div className="an-plan"><b>Plan:</b> {plan}</div>}
      </div>
    </div>
  );
});

const AnnouncementRow = memo(function AnnouncementRow({
  message,
  userById,
  currentUserId,
  canDelete,
  onDeleteMessage,
}: {
  message: Message;
  userById: Map<string, ChannelUser>;
  currentUserId: string | null;
  canDelete: boolean;
  onDeleteMessage: (message: Message) => void;
}) {
  const cd = (message.content_data ?? {}) as Record<string, unknown>;
  const isDeleted = Boolean(message.is_deleted);
  const title = !isDeleted && typeof cd.title === "string" ? cd.title : null;
  const pinnedById = typeof cd.pinned_by === "string" ? cd.pinned_by : null;
  const pinnedUser = pinnedById
    ? pinnedById === currentUserId
      ? { display_name: "Me", username: "me" }
      : userById.get(pinnedById)
    : null;
  const pinnedLabel =
    pinnedUser?.display_name ||
    pinnedUser?.username ||
    pinnedById ||
    "Channel administrator";
  return (
    <div id={`msg-${message.msg_id}`} className="an-chat-msg pl-16 pr-4 pt-2">
      <div className="an-announce">
        <div className="an-ann-ico" aria-hidden="true">!</div>
        <div className="an-ann-tag">Announcement · Announcement</div>
        {title && <div className="an-ann-title">{title}</div>}
        <div className="an-ann-body">
          {isDeleted ? "This announcement was deleted." : message.content}
        </div>
        <div className="an-ann-foot">
          <span>By {pinnedLabel} pinned</span>
          {message.created_at && (
            <>
              <span>·</span>
              <span>{formatChatTime(message.created_at)}</span>
            </>
          )}
          {canDelete && !isDeleted && (
            <>
              <span>·</span>
              <button
                type="button"
                onClick={() => onDeleteMessage(message)}
                className="an-chat-mini-action"
                title="Delete announcement"
                aria-label="Delete announcement"
              >
                <AppIcon name="trash" className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

const PermissionRow = memo(function PermissionRow({
  message,
  selectedId,
  authToken,
  botById,
  setMessageStore,
}: {
  message: Message;
  selectedId: string | null;
  authToken: string | null;
  botById: Map<string, ChannelBot>;
  setMessageStore: Dispatch<SetStateAction<MessageStore>>;
}) {
  const cd = (message.content_data ?? {}) as Record<string, unknown>;
  const tool = typeof cd.tool === "string" ? cd.tool : null;
  const body = typeof cd.body === "string" ? cd.body : message.content || "";
  const resolved = cd.resolved === true;
  const resolution =
    cd.resolution === "allow" || cd.resolution === "deny" ? cd.resolution : null;
  const senderBot =
    message.sender_type === "bot" ? botById.get(message.sender_id) : null;
  const senderLabel = senderBot?.display_name || senderBot?.username || "Bot";

  const submitResolution = async (value: "allow" | "deny") => {
    if (!selectedId) return;
    try {
      const response = await apiFetch(
        `/channels/${selectedId}/messages/${message.msg_id}/resolve`,
        { method: "POST", body: { resolution: value }, token: authToken },
      );
      if (!response.ok) return;
      const data = await response.json();
      if (data?.data?.content_data) {
        setMessageStore((prev) =>
          patchMessage(prev, message.msg_id, (current) => ({
            ...current,
            content_data: data.data.content_data,
          })),
        );
      }
    } catch {
      /* keep unresolved so the user can retry */
    }
  };

  return (
    <div id={`msg-${message.msg_id}`} className="an-chat-msg pl-16 pr-4 pt-2">
      <div className="flex items-baseline gap-1.5 mb-1 pl-1">
        <span className="an-chat-sender">{senderLabel}</span>
        <span className="an-chip off">BOT</span>
        {message.created_at && (
          <span className="an-chat-meta">{formatChatTime(message.created_at)}</span>
        )}
      </div>
      <div className={`an-approval${resolved ? " resolved" : ""}`}>
        <div className="an-body">
          <b>Approval needed.</b> {body}
          {tool && <span className="an-type-caption ml-1.5 font-mono">({tool})</span>}
          {resolved && resolution && (
            <span style={{ marginLeft: 8, color: "var(--fg-3)" }}>
              · {resolution === "allow" ? "Approved" : "Denied"}
            </span>
          )}
        </div>
        {!resolved && (
          <>
            <button type="button" className="deny" onClick={() => submitResolution("deny")}>
              Reject
            </button>
            <button type="button" className="allow" onClick={() => submitResolution("allow")}>
              Allow
            </button>
          </>
        )}
      </div>
    </div>
  );
});

const FriendRequestRow = memo(function FriendRequestRow({
  message,
  currentUserId,
  authToken,
  setMessageStore,
  setDMs,
}: {
  message: Message;
  currentUserId: string | null;
  authToken: string | null;
  setMessageStore: Dispatch<SetStateAction<MessageStore>>;
  setDMs: Dispatch<SetStateAction<DM[]>>;
}) {
  const cd = (message.content_data ?? {}) as Record<string, unknown>;
  const requester =
    cd.requester && typeof cd.requester === "object"
      ? (cd.requester as Record<string, unknown>)
      : {};
  const receiver =
    cd.receiver && typeof cd.receiver === "object"
      ? (cd.receiver as Record<string, unknown>)
      : {};
  const friendshipId = typeof cd.friendship_id === "string" ? cd.friendship_id : "";
  const status = typeof cd.status === "string" ? cd.status : "pending";
  const requesterName =
    (requester.display_name as string | undefined) ||
    (requester.username as string | undefined) ||
    "User";
  const requesterUsername = requester.username as string | undefined;
  const canResolve =
    status === "pending" &&
    friendshipId &&
    (receiver.user_id as string | undefined) === currentUserId;

  const submitFriendRequest = async (action: "accept" | "reject") => {
    try {
      const response = await apiFetch(`/friends/requests/${friendshipId}/${action}`, {
        method: "POST",
        token: authToken,
      });
      const data = await response.json();
      if (data?.status !== "success") {
        toast.error(data?.detail || data?.message || "Operation failed");
        return;
      }
      const nextStatus = action === "accept" ? "accepted" : "rejected";
      setMessageStore((prev) =>
        patchMessage(prev, message.msg_id, (current) => ({
          ...current,
          content_data: {
            ...(current.content_data || {}),
            status: nextStatus,
            resolved_by: currentUserId,
          },
        })),
      );
      refreshDMs(setDMs, authToken ?? undefined);
      toast.success(action === "accept" ? "Friend request accepted" : "Friend request rejected");
    } catch {
      toast.error("Operation failed");
    }
  };

  return (
    <div id={`msg-${message.msg_id}`} className="an-chat-msg pl-16 pr-4 pt-2">
      <div className="flex items-baseline gap-1.5 mb-1 pl-1">
        <span className="an-chat-sender">Friend notifications</span>
        {message.created_at && (
          <span className="an-chat-meta">{formatChatTime(message.created_at)}</span>
        )}
      </div>
      <div className={`an-approval${status !== "pending" ? " resolved" : ""}`}>
        <div className="an-body">
          <b>{requesterName}</b>
          {requesterUsername && (
            <span style={{ color: "var(--fg-3)", marginLeft: 6 }}>
              @{requesterUsername}
            </span>
          )}
          <span style={{ marginLeft: 6 }}>
            {status === "pending"
              ? "wants to add you as a friend"
              : status === "accepted"
                ? "is now your friend"
                : status === "rejected"
                  ? "Friend request rejected"
                  : status === "cancelled"
                    ? "Friend request withdrawn"
                    : "Friend request handled"}
          </span>
        </div>
        {canResolve && (
          <>
            <button type="button" className="deny" onClick={() => submitFriendRequest("reject")}>
              Reject
            </button>
            <button type="button" className="allow" onClick={() => submitFriendRequest("accept")}>
              Accept
            </button>
          </>
        )}
      </div>
    </div>
  );
});

const TopicChipRow = memo(function TopicChipRow({
  item,
  botById,
  currentUser,
  currentUserId,
  userById,
  setPageTopicId,
  toggleTopic,
  canDelete,
  onDeleteMessage,
}: {
  item: Extract<MessageRenderItem, { kind: "topic-chip" }>;
  botById: Map<string, ChannelBot>;
  currentUser: CurrentUser;
  currentUserId: string | null;
  userById: Map<string, ChannelUser>;
  setPageTopicId: Dispatch<SetStateAction<string | null>>;
  toggleTopic: (rootId: string) => void;
  canDelete: boolean;
  onDeleteMessage: (message: Message) => void;
}) {
  const root = item.message;
  const isDeleted = Boolean(root.is_deleted);
  const titleSummary =
    (isDeleted
      ? "This topic was deleted."
      : (root.content_data?.title as string | undefined)) ||
    root.content.replace(/\s+/g, " ").trim().slice(0, 90) ||
    "(No title)";
  type Participant = {
    key: string;
    label: string;
    avatarUrl?: string | null;
    color: string;
    initial: string;
  };
  const participants: Participant[] = [];
  const addParticipant = (message: Message) => {
    const key = `${message.sender_type}:${message.sender_id}`;
    if (participants.some((participant) => participant.key === key)) return;
    if (message.sender_type === "bot") {
      const bot = botById.get(message.sender_id);
      const label = bot?.display_name || bot?.username || "Bot";
      participants.push({
        key,
        label,
        avatarUrl: bot?.avatar_url,
        color: "var(--green)",
        initial: label.slice(0, 1).toUpperCase(),
      });
      return;
    }
    const isSelf = message.sender_id === currentUserId;
    const user = isSelf ? null : userById.get(message.sender_id);
    const label = isSelf
      ? "Me"
      : user?.display_name || user?.username || "User";
    participants.push({
      key,
      label,
      avatarUrl: isSelf ? currentUser?.avatar_url || undefined : user?.avatar_url,
      color: isSelf ? "var(--accent)" : "var(--fg-3)",
      initial: isSelf ? "Me" : label.slice(0, 1).toUpperCase(),
    });
  };
  addParticipant(root);
  for (const reply of item.replies) addParticipant(reply);
  const visibleAvatars = participants.slice(0, 5);
  const extraCount = participants.length - visibleAvatars.length;

  return (
    <div id={`msg-${root.msg_id}`} className="an-chat-msg pl-16 my-1.5 pr-4">
      <div className="an-topic-chip w-full">
        <button
          type="button"
          onClick={() => toggleTopic(root.msg_id)}
          className="an-topic-chip-faces"
          title={item.expanded ? "Collapse topic replies" : "Expand topic replies"}
        >
          {visibleAvatars.map((participant) =>
            participant.avatarUrl ? (
              <AvatarVisual
                key={participant.key}
                avatarUrl={participant.avatarUrl}
                className="an-topic-chip-face"
                fallback={participant.initial}
                label={participant.label}
                radius={8}
                size={24}
              />
            ) : (
              <span
                key={participant.key}
                className="an-topic-chip-face"
                style={{ background: participant.color }}
              >
                {participant.initial}
              </span>
            ),
          )}
          {extraCount > 0 && (
            <span
              className="an-topic-chip-face"
              style={{ background: "var(--bg-2)", color: "var(--fg-2)" }}
            >
              +{extraCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => toggleTopic(root.msg_id)}
          className="an-topic-chip-body text-left"
          title={titleSummary}
        >
          <span className="an-topic-chip-title">{titleSummary}</span>
          <span className="an-topic-chip-meta">
            Topic · {item.replies.length + 1} messages · {participants.length} participants
            {item.hiddenReplyCount > 0 ? ` · ${item.hiddenReplyCount} older replies hidden` : ""}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setPageTopicId(root.msg_id)}
          className="an-topic-chip-open"
          title="Open standalone topic view"
        >
          Open ›
        </button>
        {canDelete && !isDeleted && (
          <button
            type="button"
            onClick={() => onDeleteMessage(root)}
            className="an-chat-action"
            title="Delete topic"
            aria-label="Delete topic"
          >
            <AppIcon name="trash" className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
});

function DayDivider({ label }: { label: string }) {
  return (
    <div className="an-day-divider">
      <span>{label}</span>
    </div>
  );
}

function ProcessingBots({ processingBots }: { processingBots: Record<string, string> }) {
  return (
    <>
      {Object.entries(processingBots).map(([botId, username]) => (
        <div key={botId} className="an-chat-msg flex gap-3 px-3 py-2">
          <div
            className="an-chat-avatar lg"
            style={{ background: "var(--green-muted)", color: "var(--green)" }}
          >
            {username.slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 mb-1">
              <span className="an-chat-sender">{username}</span>
              <span className="an-chip green">Bot</span>
            </div>
            <div className="an-type-meta flex items-center gap-1.5">
              <span className="inline-flex gap-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--fg-3)] animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--fg-3)] animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--fg-3)] animate-bounce" style={{ animationDelay: "300ms" }} />
              </span>
              Typing...
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

function ChatMessageListBase({
  messagesContainerRef,
  inputRef,
  secretInputRef,
  onMessagesScroll,
  loading,
  restoringInitialScroll,
  loadingMore,
  hasMore,
  messages,
  selectedChannel,
  selectedId,
  isDmSelected,
  currentUser,
  currentUserId,
  authToken,
  renderItems,
  virtualItems,
  rowVirtualizer,
  showJumpToBottom,
  onJumpToBottom,
  botById,
  botByUsername,
  coordinatorBot,
  userById,
  revealedSecrets,
  secretTokens,
  clarifyAnsweredParentIds,
  pendingClarifyReplyMsgId,
  collapsedMessages,
  processingBots,
  secretMode,
  setMessageStore,
  setDMs,
  setComposerInput,
  setReplyingTo,
  setPageTopicId,
  revealSecretMessage,
  copyMessageText,
  renderMemoryLoadButton,
  renderStopStreamButton,
  renderPartialBadge,
  renderBotTraceStatus,
  renderAgentBridgeTaskCard,
  renderFileAttachments,
  activeAgentBridgeTaskData,
  handleMarkdownImageClick,
  handleMarkdownFileClick,
  handleClarifyContinue,
  handleClarifySkip,
  toggleTopic,
  toggleMessage,
  forwardSelectionMode = false,
  renderForwardActionButtons,
}: ChatMessageListProps) {
  const canDeleteMessage = useCallback(
    (message: Message) =>
      Boolean(
        selectedId &&
          !message.is_deleted &&
          (currentUser?.role === "system_admin" ||
            selectedChannel?.can_manage ||
            (message.sender_type === "user" && message.sender_id === currentUserId)),
      ),
    [currentUser?.role, currentUserId, selectedChannel?.can_manage, selectedId],
  );

  const deleteMessage = useCallback(
    async (message: Message) => {
      if (!selectedId || message.is_deleted) return;
      if (!confirm("Delete this message?")) return;
      try {
        const response = await apiFetch(
          `/channels/${selectedId}/messages/${message.msg_id}`,
          { method: "DELETE", token: authToken },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.status === "error") {
          throw new Error(payload?.message || payload?.detail || "Delete failed");
        }
        const updated = payload?.data as Message | undefined;
        setMessageStore((prev) =>
          patchMessage(prev, message.msg_id, (current) => ({
            ...current,
            ...(updated || {}),
            content: updated?.content ?? "",
            content_data: updated?.content_data ?? current.content_data,
            file_ids: updated?.file_ids ?? [],
            files: updated?.files ?? [],
            is_deleted: true,
            deleted_at: updated?.deleted_at ?? new Date().toISOString(),
            deleted_by: updated?.deleted_by ?? currentUserId,
            _streaming: false,
            _bot_status: undefined,
          })),
        );
        toast.success("Message deleted");
      } catch (error: unknown) {
        toast.error((error as Error).message || "Delete failed");
      }
    },
    [authToken, currentUserId, selectedId, setMessageStore],
  );

  const viewModels = useMemo(() => {
    const byId = new Map<string, MessageViewModel>();
    for (const item of renderItems) {
      if (item.kind === "day-divider") continue;
      const message = item.message;
      if (!message || byId.has(message.msg_id)) continue;
      byId.set(
        message.msg_id,
        createMessageViewModel({
          message,
          botById,
          userById,
          currentUser,
          currentUserId,
          revealedContent: revealedSecrets[message.msg_id],
          clarifyAnsweredParentIds,
          pendingClarifyReplyMsgId,
          formatTime: formatChatTime,
        }),
      );
    }
    return byId;
  }, [
    botById,
    clarifyAnsweredParentIds,
    currentUser,
    currentUserId,
    pendingClarifyReplyMsgId,
    renderItems,
    revealedSecrets,
    userById,
  ]);

  const renderItem = (item: MessageRenderItem): ReactNode => {
    if (item.kind === "day-divider") return <DayDivider label={item.dayLabel} />;
    if (item.kind === "topic-chip") {
      return (
        <TopicChipRow
          item={item}
          botById={botById}
          currentUser={currentUser}
          currentUserId={currentUserId}
          userById={userById}
          setPageTopicId={setPageTopicId}
          toggleTopic={toggleTopic}
          canDelete={canDeleteMessage(item.message)}
          onDeleteMessage={deleteMessage}
        />
      );
    }

    const message = item.message;
    if (item.kind === "message") {
      if (!message.is_deleted && message.msg_type === "routing") {
        return (
          <RoutingRow
            message={message}
            coordinatorBot={coordinatorBot}
            botByUsername={botByUsername}
          />
        );
      }
      if (!message.is_deleted && message.msg_type === "friend_request") {
        return (
          <FriendRequestRow
            message={message}
            currentUserId={currentUserId}
            authToken={authToken}
            setMessageStore={setMessageStore}
            setDMs={setDMs}
          />
        );
      }
      if (!message.is_deleted && message.msg_type === "permission") {
        return (
          <PermissionRow
            message={message}
            selectedId={selectedId}
            authToken={authToken}
            botById={botById}
            setMessageStore={setMessageStore}
          />
        );
      }
      if (message.msg_type === "announcement") {
        return (
          <AnnouncementRow
            message={message}
            userById={userById}
            currentUserId={currentUserId}
            canDelete={canDeleteMessage(message)}
            onDeleteMessage={deleteMessage}
          />
        );
      }
    }

    const vm = viewModels.get(message.msg_id);
    if (!vm) return null;
    return (
      <MessageRow
        item={item}
        vm={vm}
        selectedChannel={selectedChannel}
        selectedId={selectedId}
        isDmSelected={isDmSelected}
        inputRef={inputRef}
        secretInputRef={secretInputRef}
        secretMode={secretMode}
        secretTokens={secretTokens}
        renderFileAttachments={renderFileAttachments}
        revealSecretMessage={revealSecretMessage}
        copyMessageText={copyMessageText}
        renderMemoryLoadButton={renderMemoryLoadButton}
        renderStopStreamButton={renderStopStreamButton}
        renderPartialBadge={renderPartialBadge}
        renderBotTraceStatus={renderBotTraceStatus}
        renderAgentBridgeTaskCard={renderAgentBridgeTaskCard}
        activeAgentBridgeTaskData={activeAgentBridgeTaskData}
        handleMarkdownImageClick={handleMarkdownImageClick}
        handleMarkdownFileClick={handleMarkdownFileClick}
        handleClarifyContinue={handleClarifyContinue}
        handleClarifySkip={handleClarifySkip}
        setComposerInput={setComposerInput}
        setReplyingTo={setReplyingTo}
        toggleMessage={toggleMessage}
        collapsedMessages={collapsedMessages}
        renderForwardActionButtons={renderForwardActionButtons}
        forwardSelectionMode={forwardSelectionMode}
        canDelete={canDeleteMessage(message)}
        onDeleteMessage={deleteMessage}
      />
    );
  };

  return (
    <>
      <div
        ref={messagesContainerRef}
        className="an-chat-scroll relative flex-1 overflow-auto"
        onScroll={onMessagesScroll}
      >
        {loading ? (
          <div className="an-type-meta flex h-full items-center justify-center">
            Loading...
          </div>
        ) : (
          <>
            {restoringInitialScroll && messages.length > 0 && (
              <div className="an-type-meta pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                Loading...
              </div>
            )}
            <div
              className="py-2 px-2"
              style={{ opacity: restoringInitialScroll ? 0 : 1 }}
            >
              {loadingMore && (
                <div className="an-type-caption py-2 text-center">
                  Load more messages...
                </div>
              )}
              {!hasMore && messages.length > 0 && (
                <div className="an-type-caption py-2 text-center">
                  — All messages loaded —
                </div>
              )}
              {!loading && !loadingMore && messages.length === 0 && selectedChannel && (
                <div className="an-empty">
                  <div className="an-empty-big"># {selectedChannel.name}</div>
                  <div className="an-empty-sm">
                    No messages yet. Mention a bot or start chatting directly.
                  </div>
                  <div className="an-empty-chips">
                    {[
                      "@Coordinator summarize channel history and progress",
                      "What is the goal of this channel?",
                      "@Coordinator help me decide what to do next",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        className="an-empty-chip"
                        onClick={() => {
                          setComposerInput(suggestion);
                          setTimeout(() => inputRef.current?.focus(), 0);
                        }}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div
                style={{
                  height: rowVirtualizer.getTotalSize(),
                  position: "relative",
                  width: "100%",
                }}
              >
                {virtualItems.map((virtualItem) => {
                  const item = renderItems[virtualItem.index];
                  if (!item) return null;
                  const anchorId = item.msgId ?? item.rootId;
                  return (
                    <div
                      key={virtualItem.key}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualItem.index}
                      data-message-anchor-id={anchorId}
                      className="an-chat-virtual-row"
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      {renderItem(item)}
                    </div>
                  );
                })}
              </div>
              <ProcessingBots processingBots={processingBots} />
            </div>
          </>
        )}
      </div>
      {showJumpToBottom && (
        <button
          type="button"
          className="an-chat-jump-bottom"
          onClick={onJumpToBottom}
          title="Jump to bottom"
          aria-label="Jump to bottom"
        >
          <AppIcon name="chevronDown" className="h-4 w-4" />
          <span>Bottom</span>
        </button>
      )}
    </>
  );
}

export const ChatMessageList = memo(ChatMessageListBase);
ChatMessageList.displayName = "ChatMessageList";
