import type {
  Dispatch,
  ReactNode,
  RefObject,
  SetStateAction,
  UIEvent,
} from "react";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import toast from "react-hot-toast";
import { BotAvatar } from "../../../components/BotAvatar";
import { ClarifyInlineBlock } from "../../../components/ClarifyInlineBlock";
import {
  ChatMessageRenderer,
  MessageContentClamp,
} from "../../../components/ChatMessageRenderer";
import { AppIcon } from "../../../components/icons/AppIcon";
import { apiFetch } from "../../../api";
import {
  isClarifyReplyUserMessage,
  parseHelperPayload,
} from "../../../lib/helper";
import {
  formatDayLabel,
  formatTs,
  parseQuotePrefix,
  stripLeadingQuotePrefixes,
  TOPIC_DISPLAY_THRESHOLD,
} from "../../../lib/message";
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

export interface ChatMessageListProps {
  messagesContainerRef: RefObject<HTMLDivElement>;
  inputRef: RefObject<HTMLTextAreaElement>;
  secretInputRef: RefObject<HTMLInputElement>;
  onMessagesScroll: (event: UIEvent<HTMLDivElement>) => void;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  messages: Message[];
  selectedChannel: Channel | null;
  selectedId: string | null;
  isDmSelected: boolean;
  currentUser: CurrentUser;
  currentUserId: string | null;
  authToken: string | null;
  topicRoots: Message[];
  topicRepliesOf: (msgId: string) => Message[];
  virtualItems: VirtualItem[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  botById: Map<string, ChannelBot>;
  botByUsername: Map<string, ChannelBot>;
  coordinatorBot?: ChannelBot;
  userById: Map<string, ChannelUser>;
  msgById: Map<string, Message>;
  revealedSecrets: Record<string, string>;
  secretTokens: Record<string, string>;
  clarifyAnsweredParentIds: Set<string>;
  pendingClarifyReplyMsgId: string | null;
  expandedTopics: Set<string>;
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

export function ChatMessageList({
  messagesContainerRef,
  inputRef,
  secretInputRef,
  onMessagesScroll,
  loading,
  loadingMore,
  hasMore,
  messages,
  selectedChannel,
  selectedId,
  isDmSelected,
  currentUser,
  currentUserId,
  authToken,
  topicRoots,
  topicRepliesOf,
  virtualItems,
  rowVirtualizer,
  botById,
  botByUsername,
  coordinatorBot,
  userById,
  msgById,
  revealedSecrets,
  secretTokens,
  clarifyAnsweredParentIds,
  pendingClarifyReplyMsgId,
  expandedTopics,
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
  const actionVisibilityClass = (hoverClass = "group-hover:opacity-100") =>
    `${forwardSelectionMode ? "opacity-100" : `opacity-0 ${hoverClass}`} focus-within:opacity-100 transition-opacity`;

  return (
                <div
                  ref={messagesContainerRef}
                  className="flex-1 overflow-auto"
                  onScroll={onMessagesScroll}
                >
                  {loading ? (
                    <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                      加载中...
                    </div>
                  ) : (
                    <div className="py-2 px-2">
                      {loadingMore && (
                        <div className="text-center text-xs text-gray-400 py-2">
                          加载更多消息...
                        </div>
                      )}
                      {!hasMore && messages.length > 0 && (
                        <div className="text-center text-xs text-gray-300 py-2">
                          — 已加载全部消息 —
                        </div>
                      )}
                      {!loading &&
                        !loadingMore &&
                        messages.length === 0 &&
                        selectedChannel && (
                          <div className="an-empty">
                            <div className="an-empty-big">
                              # {selectedChannel.name}
                            </div>
                            <div className="an-empty-sm">
                              这里还没有消息。@ 调用一个 Bot 或直接开始对话。
                            </div>
                            <div className="an-empty-chips">
                              {[
                                "@Coordinator 总结这个频道最近的进展",
                                "这个频道的目标是什么？",
                                "@Coordinator 帮我接下来要做什么",
                              ].map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  className="an-empty-chip"
                                  onClick={() => {
                                    setComposerInput(s);
                                    setTimeout(
                                      () => inputRef.current?.focus(),
                                      0,
                                    );
                                  }}
                                >
                                  {s}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      {(() => {
                      const renderedRows = virtualItems.map((virtualItem) => {
                        const m = topicRoots[virtualItem.index];
                        if (!m) return null;
                        // isDM gates the "intimate" bubble + self-right
                        // treatment; channel rendering is Discord-style
                        // flat, all-left, always with sender identity.
                        const isDMRender =
                          selectedChannel?.type === "dm";
                        // ── routing card: coordinator picks + plan ──────────
                        if (m.msg_type === "routing") {
                          const cd = (m.content_data ?? {}) as Record<
                            string,
                            unknown
                          >;
                          const q = typeof cd.q === "string" ? cd.q : null;
                          const plan =
                            typeof cd.plan === "string" ? cd.plan : null;
                          const picksRaw = Array.isArray(cd.picks)
                            ? (cd.picks as Array<Record<string, unknown>>)
                            : [];
                          const picks = picksRaw.map((p) => ({
                            agent:
                              typeof p.agent === "string" ? p.agent : "agent",
                            score:
                              typeof p.score === "string" ? p.score : null,
                            why: typeof p.why === "string" ? p.why : null,
                            picked: p.picked === true,
                            secondary: p.secondary === true,
                          }));
                          const coordBot = coordinatorBot;
                          const rTime = m.created_at
                            ? formatTs(m.created_at)
                            : "";
                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 pr-4 pt-2"
                            >
                              <div className="flex items-baseline gap-1.5 mb-1 pl-1">
                                <span className="text-[13px] font-semibold text-gray-900">
                                  {coordBot?.display_name ||
                                    coordBot?.username ||
                                    "协作助手"}
                                </span>
                                <span
                                  className="an-tag coord"
                                  style={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    letterSpacing: "0.6px",
                                    padding: "1px 5px",
                                    borderRadius: 3,
                                    background: "var(--accent-muted)",
                                    color: "var(--accent)",
                                  }}
                                >
                                  COORDINATOR
                                </span>
                                {rTime && (
                                  <span className="text-[11px] text-gray-400">
                                    {rTime}
                                  </span>
                                )}
                              </div>
                              <div className="an-routing">
                                {q && (
                                  <div className="an-rq">
                                    路由: <b>{q}</b>
                                  </div>
                                )}
                                {picks.length > 0 && (
                                  <div className="an-picks">
                                    {picks.map((p) => {
                                      const bot = botByUsername.get(p.agent);
                                      const color =
                                        bot?.avatar_url ?? null;
                                      return (
                                        <span
                                          key={p.agent}
                                          className={
                                            "an-pick" +
                                            (p.picked ? " picked" : "")
                                          }
                                          title={p.why || undefined}
                                        >
                                          <span
                                            className="an-dot"
                                            style={{
                                              background: color
                                                ? "var(--accent)"
                                                : "var(--fg-3)",
                                            }}
                                          />
                                          @{p.agent}
                                          {p.score && (
                                            <span
                                              style={{
                                                color: "var(--fg-3)",
                                                marginLeft: 2,
                                                fontSize: 11,
                                              }}
                                            >
                                              {p.score}
                                            </span>
                                          )}
                                        </span>
                                      );
                                    })}
                                  </div>
                                )}
                                {plan && (
                                  <div className="an-plan">
                                    <b>计划:</b> {plan}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        }

                        // ── friend request card: Personal system notice ──────
                        if (m.msg_type === "friend_request") {
                          const cd = (m.content_data ?? {}) as Record<string, unknown>;
                          const requester =
                            cd.requester && typeof cd.requester === "object"
                              ? (cd.requester as Record<string, unknown>)
                              : {};
                          const receiver =
                            cd.receiver && typeof cd.receiver === "object"
                              ? (cd.receiver as Record<string, unknown>)
                              : {};
                          const friendshipId =
                            typeof cd.friendship_id === "string"
                              ? cd.friendship_id
                              : "";
                          const status =
                            typeof cd.status === "string" ? cd.status : "pending";
                          const requesterName =
                            (requester.display_name as string | undefined) ||
                            (requester.username as string | undefined) ||
                            "用户";
                          const requesterUsername =
                            requester.username as string | undefined;
                          const canResolve =
                            status === "pending" &&
                            friendshipId &&
                            (receiver.user_id as string | undefined) === currentUserId;
                          const submitFriendRequest = async (
                            action: "accept" | "reject",
                          ) => {
                            try {
                              const r = await apiFetch(
                                `/friends/requests/${friendshipId}/${action}`,
                                { method: "POST", token: authToken },
                              );
                              const data = await r.json();
                              if (data?.status !== "success") {
                                toast.error(data?.detail || data?.message || "操作失败");
                                return;
                              }
                              const nextStatus =
                                action === "accept" ? "accepted" : "rejected";
                              setMessageStore((prev) =>
                                patchMessage(prev, m.msg_id, (x) => ({
                                  ...x,
                                  content_data: {
                                    ...(x.content_data || {}),
                                    status: nextStatus,
                                    resolved_by: currentUserId,
                                  },
                                })),
                              );
                              refreshDMs(setDMs, authToken ?? undefined);
                              toast.success(action === "accept" ? "已同意好友申请" : "已拒绝好友申请");
                            } catch {
                              toast.error("操作失败");
                            }
                          };
                          const friendTime = m.created_at ? formatTs(m.created_at) : "";
                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 pr-4 pt-2"
                            >
                              <div className="flex items-baseline gap-1.5 mb-1 pl-1">
                                <span className="text-[13px] font-semibold text-gray-900">
                                  好友通知
                                </span>
                                {friendTime && (
                                  <span className="text-[11px] text-gray-400">
                                    {friendTime}
                                  </span>
                                )}
                              </div>
                              <div className={"an-approval" + (status !== "pending" ? " resolved" : "")}>
                                <div className="an-body">
                                  <b>{requesterName}</b>
                                  {requesterUsername && (
                                    <span style={{ color: "var(--fg-3)", marginLeft: 6 }}>
                                      @{requesterUsername}
                                    </span>
                                  )}
                                  <span style={{ marginLeft: 6 }}>
                                    {status === "pending"
                                      ? "请求添加你为好友"
                                      : status === "accepted"
                                        ? "已成为你的好友"
                                        : status === "rejected"
                                          ? "好友申请已拒绝"
                                          : status === "cancelled"
                                            ? "已撤回好友申请"
                                            : "好友申请已处理"}
                                  </span>
                                </div>
                                {canResolve && (
                                  <>
                                    <button
                                      type="button"
                                      className="deny"
                                      onClick={() => submitFriendRequest("reject")}
                                    >
                                      拒绝
                                    </button>
                                    <button
                                      type="button"
                                      className="allow"
                                      onClick={() => submitFriendRequest("accept")}
                                    >
                                      同意
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        }

                        // ── permission card: Allow/Deny for tool writes ──────
                        if (m.msg_type === "permission") {
                          const cd = (m.content_data ?? {}) as Record<
                            string,
                            unknown
                          >;
                          const tool =
                            typeof cd.tool === "string" ? cd.tool : null;
                          const body =
                            typeof cd.body === "string"
                              ? cd.body
                              : m.content || "";
                          const resolved = cd.resolved === true;
                          const resolution =
                            cd.resolution === "allow" ||
                            cd.resolution === "deny"
                              ? cd.resolution
                              : null;
                          const senderBot =
                            m.sender_type === "bot"
                              ? botById.get(m.sender_id)
                              : null;
                          const senderLabel =
                            senderBot?.display_name ||
                            senderBot?.username ||
                            "Bot";
                          const pTime = m.created_at
                            ? formatTs(m.created_at)
                            : "";
                          const submitResolution = async (
                            res: "allow" | "deny",
                          ) => {
                            try {
                              const r = await apiFetch(
                                `/channels/${selectedId}/messages/${m.msg_id}/resolve`,
                                {
                                  method: "POST",
                                  body: { resolution: res },
                                  token: authToken,
                                },
                              );
                              if (!r.ok) return;
                              const data = await r.json();
                              // Optimistic local update — the WS broadcast also
                              // merges it back in, so this mainly covers the case
                              // where the user clicks while offline-ish.
                              if (data?.data?.content_data) {
                                setMessageStore((prev) =>
                                  patchMessage(prev, m.msg_id, (x) => ({
                                    ...x,
                                    content_data: data.data.content_data,
                                  })),
                                );
                              }
                            } catch {
                              /* ignore — UI stays un-resolved so user can retry */
                            }
                          };
                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 pr-4 pt-2"
                            >
                              <div className="flex items-baseline gap-1.5 mb-1 pl-1">
                                <span className="text-[13px] font-semibold text-gray-900">
                                  {senderLabel}
                                </span>
                                <span
                                  className="an-tag bot"
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
                                {pTime && (
                                  <span className="text-[11px] text-gray-400">
                                    {pTime}
                                  </span>
                                )}
                              </div>
                              <div
                                className={
                                  "an-approval" +
                                  (resolved ? " resolved" : "")
                                }
                              >
                                <div className="an-body">
                                  <b>Approval needed.</b> {body}
                                  {tool && (
                                    <span
                                      style={{
                                        fontFamily: "var(--font-mono)",
                                        fontSize: 11,
                                        marginLeft: 6,
                                        color: "var(--fg-3)",
                                      }}
                                    >
                                      ({tool})
                                    </span>
                                  )}
                                  {resolved && resolution && (
                                    <span
                                      style={{
                                        marginLeft: 8,
                                        color: "var(--fg-3)",
                                      }}
                                    >
                                      ·{" "}
                                      {resolution === "allow"
                                        ? "已通过"
                                        : "已拒绝"}
                                    </span>
                                  )}
                                </div>
                                {!resolved && (
                                  <>
                                    <button
                                      type="button"
                                      className="deny"
                                      onClick={() => submitResolution("deny")}
                                    >
                                      拒绝
                                    </button>
                                    <button
                                      type="button"
                                      className="allow"
                                      onClick={() => submitResolution("allow")}
                                    >
                                      通过
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        }

                        // ── announcement card: pinned banner, no bubble ──────
                        if (m.msg_type === "announcement") {
                          const cd = (m.content_data ?? {}) as Record<
                            string,
                            unknown
                          >;
                          const title =
                            typeof cd.title === "string" ? cd.title : null;
                          const pinnedById =
                            typeof cd.pinned_by === "string"
                              ? cd.pinned_by
                              : null;
                          const pinnedUser = pinnedById
                            ? pinnedById === currentUserId
                              ? { display_name: "我", username: "me" }
                              : userById.get(pinnedById)
                            : null;
                          const pinnedLabel =
                            pinnedUser?.display_name ||
                            pinnedUser?.username ||
                            pinnedById ||
                            "频道管理员";
                          const annTime = m.created_at
                            ? formatTs(m.created_at)
                            : "";
                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 pr-4 pt-2"
                            >
                              <div className="an-announce">
                                <div className="an-ann-ico" aria-hidden="true">
                                  !
                                </div>
                                <div className="an-ann-tag">公告 · Announcement</div>
                                {title && (
                                  <div className="an-ann-title">{title}</div>
                                )}
                                <div className="an-ann-body">{m.content}</div>
                                <div className="an-ann-foot">
                                  <span>由 {pinnedLabel} 置顶</span>
                                  {annTime && (
                                    <>
                                      <span>·</span>
                                      <span>{annTime}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        }

                        const replies = topicRepliesOf(m.msg_id);

                        // ── helpers shared by root & replies ──────────────────
                        const replyIcon = (
                          <AppIcon name="reply" className="w-3.5 h-3.5" />
                        );

                        // ── root message ───────────────────────────────────────
                        const revealedContent = revealedSecrets[m.msg_id];
                        const effectiveContent = m.is_secret
                          ? (revealedContent ?? m.content)
                          : m.content;
                        const { text, clarify } =
                          parseHelperPayload(effectiveContent);
                        const clarifyAnswered =
                          !!clarify &&
                          clarifyAnsweredParentIds.has(m.msg_id);
                        const clarifyWaiting =
                          pendingClarifyReplyMsgId === m.msg_id;
                        const clarifyStatus:
                          | "form"
                          | "waiting"
                          | "answered"
                          | null =
                          clarify && m.sender_type === "bot"
                            ? clarifyWaiting
                              ? "waiting"
                              : clarifyAnswered
                                ? "answered"
                                : "form"
                            : null;
                        const displayContent = (() => {
                          const base = isClarifyReplyUserMessage(effectiveContent)
                            ? effectiveContent
                                .replace(
                                  /^@(?:Helper|Coordinator|channel bot|引导)\s*澄清回答[：:]\s*/i,
                                  "",
                                )
                                .trim()
                            : text || effectiveContent;
                          return m.sender_type === "bot"
                            ? stripLeadingQuotePrefixes(base)
                            : base;
                        })();
                        const isOwn =
                          m.sender_type === "user" &&
                          m.sender_id === currentUserId;
                        const senderBot =
                          m.sender_type === "bot"
                            ? botById.get(m.sender_id)
                            : undefined;
                        const botLabel =
                          m.sender_name ||
                          senderBot?.display_name ||
                          senderBot?.username ||
                          "Bot";
                        const senderUser =
                          m.sender_type === "user" && !isOwn
                            ? userById.get(m.sender_id)
                            : undefined;
                        const userLabel =
                          m.sender_name ||
                          (isOwn
                            ? currentUser?.display_name || currentUser?.username
                            : senderUser?.display_name || senderUser?.username) ||
                          "用户";
                        const userAvatarUrl = isOwn
                          ? currentUser?.avatar_url
                          : senderUser?.avatar_url;
                        const userInitials = userLabel
                          .slice(0, 1)
                          .toUpperCase();
                        const msgTime = m.created_at
                          ? new Date(m.created_at).toLocaleString("zh-CN", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "";

                        const secretSecsLeft =
                          m.is_secret && !revealedContent && m.created_at
                            ? getSecretSecondsLeft(m.created_at)
                            : null;
                        const isSecretExpired =
                          secretSecsLeft !== null && secretSecsLeft <= 0;
                        const isSecretUnrevealed =
                          m.is_secret && !revealedContent && !isSecretExpired;
                        const secretVeil = (
                          <SecretMessageVeil
                            createdAt={m.created_at}
                            canReveal={Boolean(secretTokens[m.msg_id])}
                            onReveal={() => revealSecretMessage(m.msg_id)}
                          />
                        );
                        const rootBubble = !isDMRender ? (
                          // ── Channel flat render — Discord style ────────
                          // All-left alignment, no bubble, always with avatar.
                          <div
                            id={`msg-${m.msg_id}`}
                            className="an-chat-msg group relative px-4 transition-colors"
                            style={{
                              paddingTop: 8,
                              paddingBottom: 2,
                            }}
                          >
                            {/* subtle hover tint covering the full row width */}
                            <div
                              className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ background: "var(--surface-soft)" }}
                            />
                            <div className="relative flex gap-3">
                              <div className="w-9 flex-shrink-0">
                                {m.sender_type === "bot" ? (
                                  <BotAvatar
                                    label={botLabel}
                                    avatarUrl={senderBot?.avatar_url}
                                    brandName={senderBot?.display_name || senderBot?.username || botLabel}
                                    size={36}
                                    className="mt-0.5"
                                  />
                                ) : userAvatarUrl ? (
                                  <img
                                    src={userAvatarUrl}
                                    alt={userLabel}
                                    className="w-9 h-9 rounded-xl object-cover select-none mt-0.5"
                                  />
                                ) : (
                                  <div
                                    className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none mt-0.5"
                                    style={{
                                      background: isOwn
                                        ? "var(--accent)"
                                        : "var(--fg-3)",
                                    }}
                                  >
                                    {isOwn ? "我" : userInitials}
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
                                    {isOwn
                                      ? "我"
                                      : m.sender_type === "bot"
                                        ? botLabel
                                        : userLabel}
                                  </span>
                                  <span
                                    className="text-[11px]"
                                    style={{ color: "var(--fg-3)" }}
                                  >
                                    {msgTime}
                                  </span>
                                </div>
                                {m.content_data?.title ? (
                                  <div
                                    className="text-[14px] font-semibold mb-1 leading-snug"
                                    style={{ color: "var(--fg-1)" }}
                                  >
                                    {m.content_data.title as string}
                                  </div>
                                ) : null}
                                {/* Unified reply-quote: lifted out of the
                                    body so all 4 message paths render the
                                    "回复某条消息" indicator the exact same
                                    way (.an-reply-quote with elbow connector). */}
                                {(() => {
                                  const mq = parseQuotePrefix(displayContent);
                                  if (!mq || isSecretExpired || isSecretUnrevealed)
                                    return null;
                                  return (
                                    <div
                                      className="an-reply-quote"
                                      title={`回复 ${mq.label}`}
                                    >
                                      <span className="an-rq-arrow">↪</span>
                                      <span className="an-rq-name">{mq.label}</span>
                                      <span className="an-rq-snip">
                                        {mq.quote.replace(/\s+/g, " ").trim()}
                                      </span>
                                    </div>
                                  );
                                })()}
                                {renderFileAttachments(m)}
                                <div
                                  style={{
                                    fontSize: "var(--fs-chat-body)",
                                    lineHeight: "var(--lh-chat-body)",
                                    color: "var(--fg-1)",
                                    wordWrap: "break-word",
                                  }}
                                >
                                  {isSecretExpired || isSecretUnrevealed ? (
                                    secretVeil
                                  ) : activeAgentBridgeTaskData(m) ? (
                                    renderAgentBridgeTaskCard(m)
                                  ) : (
                                    <ChatMessageRenderer
                                      collapseKey={m.msg_id}
                                      content={
                                        // Strip the `> [Author]: …\n\n` prefix
                                        // (rendered separately as .an-reply-quote
                                        // above) so the body shows only the
                                        // actual content.
                                        parseQuotePrefix(displayContent)?.rest ??
                                        displayContent
                                      }
                                      keyPrefix={`${m.msg_id}-`}
                                      streaming={!!m._streaming}
                                      showStreamingCursor={false}
                                      onImageClick={handleMarkdownImageClick}
                                      onFileClick={handleMarkdownFileClick}
                                    />
                                  )}
                                  {m._streaming &&
                                    !!(parseHelperPayload(displayContent).text ||
                                      displayContent) && (
                                      <span
                                        className="inline-block w-1.5 h-4 rounded-sm animate-pulse align-middle ml-0.5"
                                        style={{
                                          background: "var(--fg-3)",
                                        }}
                                      />
                                    )}
                                  {renderStopStreamButton(m)}
                                  {renderPartialBadge(m)}
                                </div>
                                {renderBotTraceStatus(m)}
                                {clarifyStatus !== null && selectedId && (
                                  <ClarifyInlineBlock
                                    msgId={m.msg_id}
                                    schema={clarify!}
                                    status={clarifyStatus}
                                    replyContent={undefined}
                                    onContinue={(answers) =>
                                      handleClarifyContinue(
                                        m.msg_id,
                                        clarify!,
                                        answers,
                                      )
                                    }
                                    onSkip={() =>
                                      handleClarifySkip(m.msg_id)
                                    }
                                  />
                                )}
                              </div>
                              <div className={`${actionVisibilityClass()} an-msg-actions self-start flex items-center gap-1 flex-shrink-0`}>
                                <button
                                  type="button"
                                  title="复制消息内容"
                                  onClick={() => copyMessageText(m)}
                                  className="an-chat-action"
                                >
                                  <AppIcon name="copy" className="w-3.5 h-3.5" />
                                </button>
                                {renderForwardActionButtons?.(m)}
                                {renderMemoryLoadButton(m)}
                                <button
                                  type="button"
                                  title="回复"
                                  onClick={() => {
                                    setReplyingTo(m);
                                    const mention =
                                      m.sender_type === "bot" &&
                                      senderBot?.username
                                        ? `@${senderBot.username} `
                                        : "";
                                    if (mention) setComposerInput(mention);
                                    (secretMode
                                      ? secretInputRef.current
                                      : inputRef.current
                                    )?.focus();
                                  }}
                                  className="an-chat-action"
                                >
                                  {replyIcon}
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : isOwn ? (
                          <div
                            id={`msg-${m.msg_id}`}
                            className="an-chat-msg group flex flex-row-reverse items-end gap-2.5 px-4 py-1 transition-all"
                          >
                            <div className="w-8 h-8 rounded-xl bg-[#1264A3] flex items-center justify-center text-white text-xs font-bold select-none flex-shrink-0">
                              我
                            </div>
                            <div className="flex items-end gap-1.5">
                              {renderForwardActionButtons?.(
                                m,
                                `${actionVisibilityClass()} an-chat-action mb-1`,
                                "w-3.5 h-3.5",
                              )}
                              {!isDmSelected && (
                                <button
                                  type="button"
                                  title="回复"
                                  onClick={() => {
                                    setReplyingTo(m);
                                    const mention =
                                      m.sender_type === "bot" &&
                                      senderBot?.username
                                        ? `@${senderBot.username} `
                                        : "";
                                    if (mention) setComposerInput(mention);
                                    (secretMode
                                      ? secretInputRef.current
                                      : inputRef.current
                                    )?.focus();
                                  }}
                                  className={`${actionVisibilityClass()} an-chat-action mb-1`}
                                >
                                  {replyIcon}
                                </button>
                              )}
                              <div className="an-dm-bubble-stack flex flex-col items-end max-w-[85%] sm:max-w-[72%]">
                                <div className="flex items-baseline gap-1.5 mb-1 justify-end">
                                  {!isDmSelected && m.msg_type === "topic" && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-500 font-medium leading-none">
                                      主题
                                    </span>
                                  )}
                                  <span className="text-[11px] text-gray-400 mr-0.5">
                                    {msgTime}
                                  </span>
                                </div>
                                {m.content_data?.title ? (
                                  <div className="text-[13px] font-semibold text-white/90 mb-1 mr-0.5 leading-snug text-right">
                                    {m.content_data.title as string}
                                  </div>
                                ) : null}
                                {renderFileAttachments(m, true)}
                                {/* If this user message starts with a "> [X]: ..."
                                    quote prefix (set when the user used the
                                    reply UI), surface it as a small-gray
                                    .an-reply-quote ABOVE the bubble. The
                                    bubble itself then renders just `q.rest`
                                    so the parent context doesn't intrude on
                                    the body. The CSS connector elbow visually
                                    bridges quote → body. */}
                                {(() => {
                                  const q = parseQuotePrefix(displayContent);
                                  if (!q || isSecretExpired || isSecretUnrevealed)
                                    return null;
                                  return (
                                    <div
                                      className="an-reply-quote"
                                      title={`回复 ${q.label}`}
                                    >
                                      <span className="an-rq-arrow">↪</span>
                                      <span className="an-rq-name">{q.label}</span>
                                      <span className="an-rq-snip">
                                        {q.quote.replace(/\s+/g, " ").trim()}
                                      </span>
                                    </div>
                                  );
                                })()}
                                {isSecretExpired || isSecretUnrevealed ? (
                                  secretVeil
                                ) : (
                                  <div
                                    className="bg-[#1264A3] text-white rounded-2xl rounded-tr-sm px-3.5 py-2 text-[14px] leading-relaxed break-words"
                                  >
                                    {(() => {
                                      // The quote prefix (if any) is already
                                      // rendered above as .an-reply-quote;
                                      // here we render only the body text.
                                      const q =
                                        parseQuotePrefix(displayContent);
                                      const body = q ? q.rest : displayContent;
                                      return (
                                        <MessageContentClamp contentKey={m.msg_id}>
                                          <span className="whitespace-pre-wrap">
                                            {body
                                              .replace(/!\[.*?\]\(.*?\)\s*/g, "")
                                              .trim() || body}
                                          </span>
                                        </MessageContentClamp>
                                      );
                                    })()}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div
                            id={`msg-${m.msg_id}`}
                            className="an-chat-msg group flex items-start gap-2.5 px-4 py-1 transition-all"
                          >
                            <div className="flex-shrink-0 mt-0.5">
                              {m.sender_type === "bot" ? (
                                <BotAvatar
                                  label={botLabel}
                                  avatarUrl={senderBot?.avatar_url}
                                  brandName={senderBot?.display_name || senderBot?.username || botLabel}
                                  size={32}
                                />
                              ) : userAvatarUrl ? (
                                <img
                                  src={userAvatarUrl}
                                  alt={userLabel}
                                  className="w-8 h-8 rounded-xl object-cover select-none"
                                />
                              ) : (
                                <div className="w-8 h-8 rounded-xl bg-gray-400 flex items-center justify-center text-white text-xs font-bold select-none">
                                  {userInitials}
                                </div>
                              )}
                            </div>
                            <div className="an-dm-bubble-stack flex flex-col max-w-[85%] sm:max-w-[72%]">
                              <div className="flex items-baseline gap-1.5 mb-1">
                                <span className="font-semibold text-[13px] text-gray-900 leading-none">
                                  {m.sender_type === "bot"
                                    ? botLabel
                                    : userLabel}
                                </span>
                                {m.sender_type === "bot" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[#2EB67D]/10 text-[#2EB67D] font-medium leading-none">
                                    Bot
                                  </span>
                                )}
                                {!isDmSelected && m.msg_type === "topic" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-500 font-medium leading-none">
                                    主题
                                  </span>
                                )}
                                <span className="text-[11px] text-gray-400 leading-none">
                                  {msgTime}
                                </span>
                              </div>
                              {m.content_data?.title ? (
                                <div className="text-[13px] font-semibold text-gray-700 mb-1 leading-snug">
                                  {m.content_data.title as string}
                                </div>
                              ) : null}
                              {(() => {
                                const cq = parseQuotePrefix(text);
                                if (!cq) return null;
                                return (
                                  <div
                                    className="an-reply-quote"
                                    title={`回复 ${cq.label}`}
                                  >
                                    <span className="an-rq-arrow">↪</span>
                                    <span className="an-rq-name">
                                      {cq.label}
                                    </span>
                                    <span className="an-rq-snip">
                                      {cq.quote.replace(/\s+/g, " ").trim()}
                                    </span>
                                  </div>
                                );
                              })()}
                              {renderFileAttachments(m)}
                              <div
                                className="rounded-2xl rounded-tl-sm px-3.5 py-2 text-[14px] leading-relaxed"
                                style={{
                                  background: isSecretUnrevealed
                                    ? "var(--orange-muted)"
                                    : "var(--surface-soft)",
                                  color: "var(--fg-1)",
                                  border: "1px solid var(--border)",
                                }}
                              >
                                {isSecretExpired || isSecretUnrevealed ? (
                                  secretVeil
                                ) : activeAgentBridgeTaskData(m) ? (
                                  renderAgentBridgeTaskCard(m)
                                ) : m._streaming && !text ? (
                                  <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                                ) : (
                                  <ChatMessageRenderer
                                    collapseKey={m.msg_id}
                                    content={parseQuotePrefix(text)?.rest ?? text}
                                    keyPrefix={`${m.msg_id}-`}
                                    streaming={!!m._streaming}
                                    showStreamingCursor={false}
                                    onImageClick={handleMarkdownImageClick}
                                    onFileClick={handleMarkdownFileClick}
                                  />
                                )}
                                {!isSecretUnrevealed &&
                                  m._streaming &&
                                  !!text && (
                                    <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />
                                  )}
                                {!isSecretUnrevealed && renderStopStreamButton(m)}
                                {!isSecretUnrevealed && renderPartialBadge(m)}
                              </div>
                              {renderBotTraceStatus(m)}
                              {clarifyStatus !== null && selectedId && (
                                <ClarifyInlineBlock
                                  msgId={m.msg_id}
                                  schema={clarify!}
                                  status={clarifyStatus}
                                  replyContent={undefined}
                                  onContinue={(answers) =>
                                    handleClarifyContinue(
                                      m.msg_id,
                                      clarify!,
                                      answers,
                                    )
                                  }
                                  onSkip={() => handleClarifySkip(m.msg_id)}
                                />
                              )}
                            </div>
                            <div className={`${actionVisibilityClass()} an-msg-actions self-center flex items-center gap-1 flex-shrink-0`}>
                              {renderForwardActionButtons?.(
                                m,
                                "an-chat-action",
                                "w-3.5 h-3.5",
                              )}
                              {renderMemoryLoadButton(m)}
                              {!isDmSelected && (
                                <button
                                  type="button"
                                  title="回复"
                                  onClick={() => {
                                    setReplyingTo(m);
                                    const mention =
                                      m.sender_type === "bot" && senderBot?.username
                                        ? `@${senderBot.username} `
                                        : "";
                                    if (mention) setComposerInput(mention);
                                    (secretMode
                                      ? secretInputRef.current
                                      : inputRef.current
                                    )?.focus();
                                  }}
                                  className="an-chat-action"
                                >
                                  {replyIcon}
                                </button>
                              )}
                            </div>
                          </div>
                        );

                        // ── topic card ───────────────────────────────────────
                        // An explicit topic message (msg_type="topic") should render
                        // as a topic card regardless of reply count, so the
                        // user sees the intent reflected immediately. The
                        // 4-reply threshold only gates implicit promotion of
                        // a normal message that's accumulated replies.
                        const isExplicitTopic = !isDmSelected && m.msg_type === "topic";
                        // Force expansion when there's nothing to collapse
                        // (0-reply explicit topic) — otherwise the collapsed
                        // preview path would blow up on replies[length-1].
                        const isExpanded =
                          expandedTopics.has(m.msg_id) ||
                          (isExplicitTopic && replies.length === 0);

                        // No replies and not an explicit topic — render as a
                        // plain standalone bubble.
                        if (!isExplicitTopic && replies.length === 0) {
                          return <div key={m.msg_id}>{rootBubble}</div>;
                        }

                        // 1–3 replies on a plain message — inline render, no
                        // topic chrome. Explicit topic messages fall through
                        // to the topic-card branch below regardless of count.
                        if (
                          !isExplicitTopic &&
                          replies.length < TOPIC_DISPLAY_THRESHOLD
                        ) {
                          const renderReplyRow = (r: Message) => {
                          const rIsOwn =
                            r.sender_type === "user" &&
                            r.sender_id === currentUserId;
                          const rBot =
                            r.sender_type === "bot"
                              ? botById.get(r.sender_id)
                              : undefined;
                          const rSenderUser =
                            r.sender_type === "user" && !rIsOwn
                              ? userById.get(r.sender_id)
                              : undefined;
                          const rLabel = rBot
                            ? rBot.display_name || rBot.username || "Bot"
                            : rIsOwn
                              ? "我"
                              : rSenderUser?.display_name ||
                                rSenderUser?.username ||
                                "用户";
                          const rInitials = rLabel.slice(0, 2).toUpperCase();
                          const rTime = r.created_at
                            ? new Date(r.created_at).toLocaleString("zh-CN", {
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "";
                          const {
                            text: rTextRaw,
                            clarify: rClarify,
                          } = parseHelperPayload(r.content);
                          const rDisplay = (() => {
                            const base = isClarifyReplyUserMessage(r.content)
                              ? r.content
                                  .replace(
                                    /^@(?:Helper|Coordinator|channel bot|引导)\s*澄清回答[：:]\s*/i,
                                    "",
                                  )
                                  .trim()
                              : rTextRaw || r.content;
                            return r.sender_type === "bot"
                              ? stripLeadingQuotePrefixes(base)
                              : base;
                          })();
                          const rClarifyAnswered =
                            !!rClarify &&
                            clarifyAnsweredParentIds.has(r.msg_id);
                          const rClarifyWaiting =
                            pendingClarifyReplyMsgId === r.msg_id;
                          const rClarifyStatus:
                            | "form"
                            | "waiting"
                            | "answered"
                            | null =
                            rClarify && r.sender_type === "bot"
                              ? rClarifyWaiting
                                ? "waiting"
                                : rClarifyAnswered
                                  ? "answered"
                                  : "form"
                              : null;
                          // Channel flat-reply render: no bubble, all-left,
                          // iridescent outline on bot replies. DMs keep the
                          // bubble treatment below.
                          const rFlat = !isDMRender;
                          return (
                            <div
                              key={r.msg_id}
                              id={`msg-${r.msg_id}`}
                              className={
                                rFlat
                                  ? "an-chat-msg group flex gap-3 px-4 py-1 items-start transition-colors"
                                  : `an-chat-msg group flex gap-2.5 px-4 py-1 transition-all ${
                                      rIsOwn
                                        ? "flex-row-reverse items-end"
                                        : "items-start"
                                    }`
                              }
                            >
                                <div className="flex-shrink-0 mt-0.5">
                                  {r.sender_type === "bot" ? (
                                    rBot?.avatar_url ? (
                                      <img
                                        src={rBot.avatar_url}
                                        alt={rLabel}
                                        className={
                                          rFlat
                                            ? "w-9 h-9 rounded-xl object-cover"
                                            : "w-8 h-8 rounded-xl object-cover"
                                        }
                                      />
                                    ) : (
                                      <div
                                        className={
                                          rFlat
                                            ? "w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none"
                                            : "w-8 h-8 rounded-xl bg-[#2EB67D] flex items-center justify-center text-white text-xs font-bold select-none"
                                        }
                                        style={
                                          rFlat
                                            ? { background: "var(--fg-3)" }
                                            : undefined
                                        }
                                      >
                                        {rInitials}
                                      </div>
                                    )
                                  ) : (
                                    <div
                                      className={
                                        rFlat
                                          ? "w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none"
                                          : `w-8 h-8 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none ${rIsOwn ? "bg-[#1264A3]" : "bg-gray-400"}`
                                      }
                                      style={
                                        rFlat
                                          ? {
                                              background: rIsOwn
                                                ? "var(--accent)"
                                                : "var(--fg-3)",
                                            }
                                          : undefined
                                      }
                                    >
                                      {rIsOwn ? "我" : rInitials}
                                    </div>
                                  )}
                                </div>
                                <div
                                  className={
                                    rFlat
                                      ? "flex-1 min-w-0 flex flex-col"
                                      : `an-dm-bubble-stack flex flex-col max-w-[85%] sm:max-w-[72%] ${rIsOwn ? "items-end" : ""}`
                                  }
                                >
                                  <div
                                    className={
                                      rFlat
                                        ? "flex items-baseline gap-2 mb-0.5 flex-wrap"
                                        : `flex items-baseline gap-1.5 mb-1 ${rIsOwn ? "justify-end" : ""}`
                                    }
                                  >
                                    <span
                                      className="font-semibold text-[13.5px] leading-none"
                                      style={{ color: "var(--fg-1)" }}
                                    >
                                      {rIsOwn ? "我" : rLabel}
                                    </span>
                                    <span
                                      className="text-[11px] leading-none"
                                      style={{ color: "var(--fg-3)" }}
                                    >
                                      {rTime}
                                    </span>
                                  </div>
                                  {(() => {
                                    // Unified reply-quote rendering for the
                                    // rFlat (channel-list reply) path. Source
                                    // of truth = the `> [Author]: snippet`
                                    // prefix on the message text, set by the
                                    // reply UI. We strip it from the body
                                    // and surface it as .an-reply-quote so
                                    // the visual exactly matches the topic-
                                    // view and own-bubble paths.
                                    const rq = parseQuotePrefix(rDisplay);
                                    if (!rq) return null;
                                    return (
                                      <div
                                        className="an-reply-quote"
                                        title={`回复 ${rq.label}`}
                                      >
                                        <span className="an-rq-arrow">↪</span>
                                        <span className="an-rq-name">
                                          {rq.label}
                                        </span>
                                        <span className="an-rq-snip">
                                          {rq.quote.replace(/\s+/g, " ").trim()}
                                        </span>
                                      </div>
                                    );
                                  })()}
                                  {renderFileAttachments(r)}
                                  <div
                                    className={
                                      rFlat
                                        ? ""
                                        : `rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed ${
                                            rIsOwn
                                              ? "text-white rounded-tr-sm"
                                              : "rounded-tl-sm"
                                          }`
                                    }
                                    style={
                                      rFlat
                                        ? {
                                            fontSize: "var(--fs-chat-body)",
                                            lineHeight:
                                              "var(--lh-chat-body)",
                                            color: "var(--fg-1)",
                                            wordWrap: "break-word",
                                          }
                                        : rIsOwn
                                          ? { background: "var(--accent)" }
                                          : {
                                              background:
                                                "var(--surface-soft)",
                                              color: "var(--fg-1)",
                                              border:
                                                "1px solid var(--border)",
                                            }
                                    }
                                  >
                                    {activeAgentBridgeTaskData(r) ? (
                                      renderAgentBridgeTaskCard(r)
                                    ) : r._streaming && !rTextRaw ? (
                                      <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                                    ) : (
                                      <ChatMessageRenderer
                                        collapseKey={r.msg_id}
                                        content={
                                          // Drop the `> [Author]: …\n\n` prefix
                                          // (now rendered above as an
                                          // .an-reply-quote) so the body shows
                                          // only the actual content.
                                          parseQuotePrefix(rDisplay)?.rest ?? rDisplay
                                        }
                                        keyPrefix={`${r.msg_id}-`}
                                        streaming={!!r._streaming}
                                        showStreamingCursor={false}
                                        onImageClick={handleMarkdownImageClick}
                                        onFileClick={handleMarkdownFileClick}
                                      />
                                    )}
                                    {r._streaming && !!rTextRaw && (
                                      <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />
                                    )}
                                    {renderStopStreamButton(r)}
                                    {renderPartialBadge(r)}
                                  </div>
                                  {renderBotTraceStatus(r)}
                                  {rClarifyStatus !== null && selectedId && (
                                    <ClarifyInlineBlock
                                      msgId={r.msg_id}
                                      schema={rClarify!}
                                      status={rClarifyStatus}
                                      replyContent={undefined}
                                      onContinue={(answers) =>
                                        handleClarifyContinue(
                                          r.msg_id,
                                          rClarify!,
                                          answers,
                                        )
                                      }
                                      onSkip={() => handleClarifySkip(r.msg_id)}
                                    />
                                  )}
                                </div>
                                <div className={`${actionVisibilityClass()} an-msg-actions self-start flex items-center gap-1 flex-shrink-0`}>
                                  <button
                                    type="button"
                                    title="复制消息内容"
                                    onClick={() => copyMessageText(r)}
                                    className="an-chat-action"
                                  >
                                    <AppIcon name="copy" className="w-3.5 h-3.5" />
                                  </button>
                                  {renderForwardActionButtons?.(r)}
                                  {renderMemoryLoadButton(r)}
                                  <button
                                    type="button"
                                    title="回复"
                                    onClick={() => {
                                      setReplyingTo(r);
                                      const mention =
                                        r.sender_type === "bot" && rBot?.username
                                          ? `@${rBot.username} `
                                          : "";
                                      if (mention) setComposerInput(mention);
                                      (secretMode
                                        ? secretInputRef.current
                                        : inputRef.current
                                      )?.focus();
                                    }}
                                    className="an-chat-action"
                                  >
                                    <AppIcon name="reply" className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                          );
                          };
                          return (
                            <div key={m.msg_id}>
                              {rootBubble}
                              {replies.map(renderReplyRow)}
                            </div>
                          );
                        }

                        // ≥ TOPIC_DISPLAY_THRESHOLD replies — Collapsed topic
                        // card (overview) ───────────────────────────────────────
                        // Compact form: stacked participant avatars + summary.
                        // No full question/last-reply preview — click to expand.
                        if (!isExpanded) {
                          const titleSummary =
                            (m.content_data?.title as string | undefined) ||
                            displayContent
                              .replace(/\s+/g, " ")
                              .trim()
                              .slice(0, 80) ||
                            "(无标题)";
                          // Participants = root sender ∪ all unique reply
                          // senders. Keep insertion order so the root comes
                          // first and reads as the "owner" of the topic.
                          type Participant = {
                            key: string;
                            kind: "user" | "bot";
                            label: string;
                            color: string;
                            avatarUrl?: string;
                            initial: string;
                            isSelf?: boolean;
                          };
                          const addParticipant = (
                            acc: Participant[],
                            sid: string,
                            stype: string,
                          ) => {
                            const key = `${stype}:${sid}`;
                            if (acc.some((p) => p.key === key)) return;
                            if (stype === "bot") {
                              const b = botById.get(sid);
                              const label =
                                b?.display_name || b?.username || "Bot";
                              acc.push({
                                key,
                                kind: "bot",
                                label,
                                color: "var(--green)",
                                avatarUrl: b?.avatar_url,
                                initial: label.slice(0, 1).toUpperCase(),
                              });
                            } else {
                              const isSelf = sid === currentUserId;
                              const u = isSelf
                                ? null
                                : userById.get(sid);
                              const label = isSelf
                                ? "我"
                                : u?.display_name ||
                                  u?.username ||
                                  "用户";
                              acc.push({
                                key,
                                kind: "user",
                                label,
                                color: isSelf
                                  ? "var(--accent)"
                                  : "var(--fg-3)",
                                avatarUrl: isSelf
                                  ? currentUser?.avatar_url || undefined
                                  : u?.avatar_url || undefined,
                                initial: isSelf
                                  ? "我"
                                  : label.slice(0, 1).toUpperCase(),
                                isSelf,
                              });
                            }
                          };
                          const participants: Participant[] = [];
                          addParticipant(
                            participants,
                            m.sender_id,
                            m.sender_type,
                          );
                          for (const r of replies) {
                            addParticipant(
                              participants,
                              r.sender_id,
                              r.sender_type,
                            );
                          }
                          const visibleAvatars = participants.slice(0, 5);
                          const extraCount =
                            participants.length - visibleAvatars.length;

                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 my-1.5"
                            >
                              <button
                                type="button"
                                onClick={() => toggleTopic(m.msg_id)}
                                className="an-topic-chip"
                                title={titleSummary}
                              >
                                <span className="an-topic-chip-faces">
                                  {visibleAvatars.map((p) =>
                                    p.avatarUrl ? (
                                      <img
                                        key={p.key}
                                        src={p.avatarUrl}
                                        alt={p.label}
                                        className="an-topic-chip-face"
                                      />
                                    ) : (
                                      <span
                                        key={p.key}
                                        className="an-topic-chip-face"
                                        style={{ background: p.color }}
                                      >
                                        {p.initial}
                                      </span>
                                    ),
                                  )}
                                  {extraCount > 0 && (
                                    <span
                                      className="an-topic-chip-face"
                                      style={{
                                        background: "var(--bg-2)",
                                        color: "var(--fg-2)",
                                      }}
                                    >
                                      +{extraCount}
                                    </span>
                                  )}
                                </span>
                                <span className="an-topic-chip-body">
                                  <span className="an-topic-chip-title">
                                    {titleSummary}
                                  </span>
                                  <span className="an-topic-chip-meta">
                                    主题 · {replies.length + 1} 条消息 ·{" "}
                                    {participants.length} 人参与
                                  </span>
                                </span>
                                <span className="an-topic-chip-open">
                                  展开 ›
                                </span>
                              </button>
                            </div>
                          );
                        }

                        // ── Expanded topic card ───────────────────────────────
                        return (
                          <div
                            key={m.msg_id}
                            className="an-chat-msg pl-16 my-1.5"
                          >
                            <div className="an-topic-card">
                              {/* Topic header */}
                              <div className="an-topic-card-head">
                                <div className="an-topic-card-title">
                                  <AppIcon name="messageCircle" className="w-3.5 h-3.5" />
                                  <span className="truncate">
                                    主题 · {replies.length + 1} 条消息
                                  </span>
                                </div>
                                <div className="an-topic-card-actions">
                                  <button
                                    type="button"
                                    onClick={() => setPageTopicId(m.msg_id)}
                                    className="an-topic-card-action"
                                    title="以独立页打开主题"
                                  >
                                    <AppIcon name="externalLink" className="w-3 h-3" />
                                    独立页打开
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => toggleTopic(m.msg_id)}
                                    className="an-topic-card-action"
                                  >
                                    <AppIcon name="chevronUp" className="w-3 h-3" />
                                    收起
                                  </button>
                                </div>
                              </div>
                              {/* Root message */}
                              {rootBubble}
                              {/* Replies divider */}
                              <div className="an-topic-card-divider">
                                <span>{replies.length} 条回复</span>
                              </div>
                              {/* Reply messages */}
                              <div className="flex flex-col gap-0.5 pb-1.5">
                                {replies.map((r) => {
                                const rIsOwn =
                                  r.sender_type === "user" &&
                                  r.sender_id === currentUserId;
                                const rBot =
                                  r.sender_type === "bot"
                                    ? botById.get(r.sender_id)
                                    : undefined;
                                const rSenderUser =
                                  r.sender_type === "user" && !rIsOwn
                                    ? userById.get(r.sender_id)
                                    : undefined;
                                const rLabel = rBot
                                  ? rBot.display_name || rBot.username || "Bot"
                                  : rIsOwn
                                    ? "我"
                                    : rSenderUser?.display_name ||
                                      rSenderUser?.username ||
                                      "用户";
                                const rInitials = rLabel
                                  .slice(0, 2)
                                  .toUpperCase();
                                const rTime = r.created_at
                                  ? new Date(r.created_at).toLocaleTimeString(
                                      "zh-CN",
                                      { hour: "2-digit", minute: "2-digit" },
                                    )
                                  : "";
                                const {
                                  text: rTextRaw,
                                  clarify: rClarify,
                                } = parseHelperPayload(r.content);
                                const rDisplay = (() => {
                                  const base = isClarifyReplyUserMessage(r.content)
                                    ? r.content
                                        .replace(
                                          /^@(?:Helper|Coordinator|channel bot|引导)\s*澄清回答[：:]\s*/i,
                                          "",
                                        )
                                        .trim()
                                    : rTextRaw || r.content;
                                  return r.sender_type === "bot"
                                    ? stripLeadingQuotePrefixes(base)
                                    : base;
                                })();
                                const rClarifyAnswered =
                                  !!rClarify &&
                                  clarifyAnsweredParentIds.has(r.msg_id);
                                const rClarifyWaiting =
                                  pendingClarifyReplyMsgId === r.msg_id;
                                const rClarifyStatus:
                                  | "form"
                                  | "waiting"
                                  | "answered"
                                  | null =
                                  rClarify && r.sender_type === "bot"
                                    ? rClarifyWaiting
                                      ? "waiting"
                                      : rClarifyAnswered
                                        ? "answered"
                                        : "form"
                                    : null;
                                const rDirectParent =
                                  r.in_reply_to_msg_id !== m.msg_id
                                    ? msgById.get(r.in_reply_to_msg_id || "")
                                    : null;
                                const rParentBot =
                                  rDirectParent?.sender_type === "bot"
                                    ? botById.get(rDirectParent.sender_id)
                                    : null;
                                const rParentSenderUser =
                                  rDirectParent?.sender_type === "user" &&
                                  rDirectParent.sender_id !== currentUserId
                                    ? userById.get(rDirectParent.sender_id)
                                    : undefined;
                                const rParentLabel = rDirectParent
                                  ? rDirectParent.sender_type === "bot"
                                    ? rParentBot?.display_name ||
                                      rParentBot?.username ||
                                      "Bot"
                                    : rDirectParent.sender_id === currentUserId
                                      ? "我"
                                      : rParentSenderUser?.display_name ||
                                        rParentSenderUser?.username ||
                                        "用户"
                                  : null;
                                const rCollapsed = collapsedMessages.has(
                                  r.msg_id,
                                );
                                const rPreview =
                                  rDisplay.replace(/\s+/g, " ").slice(0, 10) +
                                  (rDisplay.length > 10 ? "…" : "");
                                return (
                                  <div
                                    key={r.msg_id}
                                    id={`msg-${r.msg_id}`}
                                    className="group/tr flex items-start gap-2 px-3 py-1"
                                  >
                                    {r.sender_type === "bot" ? (
                                      rBot?.avatar_url ? (
                                        <img
                                          src={rBot.avatar_url}
                                          alt={rLabel}
                                          className="w-6 h-6 rounded-lg object-cover flex-shrink-0 mt-0.5"
                                        />
                                      ) : (
                                        <div className="w-6 h-6 rounded-lg bg-[#2EB67D] flex items-center justify-center text-white text-[10px] font-bold select-none flex-shrink-0 mt-0.5">
                                          {rInitials}
                                        </div>
                                      )
                                    ) : (
                                      <div
                                        className={`w-6 h-6 rounded-lg flex items-center justify-center text-white text-[10px] font-bold select-none flex-shrink-0 mt-0.5 ${rIsOwn ? "bg-[#1264A3]" : "bg-gray-400"}`}
                                      >
                                        {rIsOwn ? "我" : rInitials}
                                      </div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-baseline gap-1.5 mb-0.5 flex-wrap">
                                        <span className="font-semibold text-[12px] text-gray-900">
                                          {rLabel}
                                        </span>
                                        {r.sender_type === "bot" && (
                                          <span className="text-[9px] px-1 py-0.5 rounded bg-[#2EB67D]/10 text-[#2EB67D] font-medium">
                                            Bot
                                          </span>
                                        )}
                                        <span className="text-[11px] text-gray-400">
                                          {rTime}
                                        </span>
                                        {rCollapsed && (
                                          <span className="text-[11px] text-gray-400 truncate max-w-[120px]">
                                            {rPreview}
                                          </span>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() =>
                                            toggleMessage(r.msg_id)
                                          }
                                          className="opacity-0 group-hover/tr:opacity-100 transition-opacity ml-0.5 flex items-center justify-center w-4 h-4 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex-shrink-0"
                                          title={rCollapsed ? "展开" : "折叠"}
                                        >
                                          {rCollapsed ? (
                                            <AppIcon name="chevronDown" className="w-3 h-3" />
                                          ) : (
                                            <AppIcon name="chevronUp" className="w-3 h-3" />
                                          )}
                                        </button>
                                      </div>
                                      {!rCollapsed && rDirectParent && rParentLabel && (
                                        <button
                                          type="button"
                                          className="an-reply-quote"
                                          onClick={() => {
                                            const el = document.getElementById(
                                              `msg-${rDirectParent.msg_id}`,
                                            );
                                            if (!el) return;
                                            el.scrollIntoView({
                                              block: "center",
                                              behavior: "smooth",
                                            });
                                            const origT = el.style.transition;
                                            const prevBg = el.style.background;
                                            el.style.transition =
                                              "background 200ms";
                                            el.style.background =
                                              "var(--accent-muted)";
                                            setTimeout(() => {
                                              el.style.background = prevBg;
                                              el.style.transition = origT;
                                            }, 1200);
                                          }}
                                          title="跳转到被回复的消息"
                                        >
                                          <span className="an-rq-arrow">↪</span>
                                          <span className="an-rq-name">
                                            {rParentLabel}
                                          </span>
                                          <span className="an-rq-snip">
                                            {(
                                              rDirectParent.content || ""
                                            )
                                              .replace(/<think>[\s\S]*?<\/think>/g, "")
                                              .replace(/\s+/g, " ")
                                              .trim()
                                              .slice(0, 80) ||
                                              "(无内容)"}
                                          </span>
                                        </button>
                                      )}
                                      {!rCollapsed && (
                                        <>
                                          {renderFileAttachments(r)}
                                          <div
                                            className={`rounded-xl px-2.5 py-1.5 text-[13px] leading-relaxed ${rIsOwn ? "whitespace-pre-wrap break-words" : ""}`}
                                            style={
                                              rIsOwn
                                                ? {
                                                    background:
                                                      "var(--accent-muted)",
                                                    color: "var(--fg-1)",
                                                  }
                                                : {
                                                    background:
                                                      "var(--surface-soft)",
                                                    color: "var(--fg-1)",
                                                    border:
                                                      "1px solid var(--border)",
                                                  }
                                            }
                                          >
                                            {r._streaming && !rTextRaw ? (
                                              <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                                            ) : (
                                              <ChatMessageRenderer
                                                collapseKey={r.msg_id}
                                                content={rDisplay}
                                                keyPrefix={`${r.msg_id}-t-`}
                                                streaming={!!r._streaming}
                                                showStreamingCursor={false}
                                                onImageClick={handleMarkdownImageClick}
                                                onFileClick={handleMarkdownFileClick}
                                              />
                                            )}
                                            {r._streaming && !!rTextRaw && (
                                              <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />
                                            )}
                                            {renderStopStreamButton(r)}
                                            {renderPartialBadge(r)}
                                          </div>
                                          {renderBotTraceStatus(r)}
                                          {rClarifyStatus !== null &&
                                            selectedId && (
                                              <ClarifyInlineBlock
                                                msgId={r.msg_id}
                                                schema={rClarify!}
                                                status={rClarifyStatus}
                                                replyContent={undefined}
                                                onContinue={(answers) =>
                                                  handleClarifyContinue(
                                                    r.msg_id,
                                                    rClarify!,
                                                    answers,
                                                  )
                                                }
                                                onSkip={() =>
                                                  handleClarifySkip(r.msg_id)
                                                }
                                              />
                                            )}
                                        </>
                                      )}
                                    </div>
                                    <div className={`${actionVisibilityClass("group-hover/tr:opacity-100")} an-msg-actions self-center flex items-center gap-1 flex-shrink-0`}>
                                      {renderForwardActionButtons?.(
                                        r,
                                        "an-chat-action",
                                        "w-3 h-3",
                                      )}
                                      {renderMemoryLoadButton(r)}
                                      <button
                                        type="button"
                                        title="回复"
                                        onClick={() => {
                                          setReplyingTo(r);
                                          const mention =
                                            r.sender_type === "bot" &&
                                            rBot?.username
                                              ? `@${rBot.username} `
                                              : "";
                                          if (mention) setComposerInput(mention);
                                          (secretMode
                                            ? secretInputRef.current
                                            : inputRef.current
                                          )?.focus();
                                        }}
                                        className="an-chat-action"
                                      >
                                        <AppIcon name="reply" className="w-3 h-3" />
                                      </button>
                                    </div>
                                  </div>
                                );
                                })}
                              </div>
                              {/* Bottom collapse button */}
                              <div className="an-topic-card-foot">
                                <button
                                  type="button"
                                  onClick={() => toggleTopic(m.msg_id)}
                                  className="an-topic-card-action"
                                >
                                  <AppIcon name="chevronUp" className="w-3 h-3" />
                                  收起主题
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      });
                      return (
                        <div
                          style={{
                            height: rowVirtualizer.getTotalSize(),
                            position: "relative",
                            width: "100%",
                          }}
                        >
                          {virtualItems.map((virtualItem, i) => {
                            const m = topicRoots[virtualItem.index];
                            if (!m) return null;
                            const day = formatDayLabel(m.created_at);
                            const prevDay =
                              virtualItem.index > 0
                                ? formatDayLabel(
                                    topicRoots[virtualItem.index - 1]?.created_at,
                                  )
                                : "";
                            return (
                              <div
                                key={virtualItem.key}
                                ref={rowVirtualizer.measureElement}
                                data-index={virtualItem.index}
                                style={{
                                  position: "absolute",
                                  top: 0,
                                  left: 0,
                                  width: "100%",
                                  transform: `translateY(${virtualItem.start}px)`,
                                }}
                              >
                                {day && day !== prevDay ? (
                                  <div
                                    key={`day-${virtualItem.index}-${day}`}
                                    className="an-day-divider"
                                  >
                                    <span>{day}</span>
                                  </div>
                                ) : null}
                                {renderedRows[i]}
                              </div>
                            );
                          })}
                        </div>
                      );
                      })()}
                      {Object.entries(processingBots).map(
                        ([botId, username]) => (
                          <div key={botId} className="an-chat-msg flex gap-3 px-3 py-2">
                            <div className="w-9 h-9 rounded-xl bg-[#2EB67D]/20 flex items-center justify-center text-[#2EB67D] text-sm font-bold flex-shrink-0">
                              {username.slice(0, 1).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline gap-2 mb-1">
                                <span className="font-semibold text-[14px] text-gray-900">
                                  {username}
                                </span>
                                <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-[#2EB67D]/10 text-[#2EB67D] font-medium">
                                  Bot
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 text-[13px] text-gray-400">
                                <span className="inline-flex gap-0.5">
                                  <span
                                    className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce"
                                    style={{ animationDelay: "0ms" }}
                                  />
                                  <span
                                    className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce"
                                    style={{ animationDelay: "150ms" }}
                                  />
                                  <span
                                    className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce"
                                    style={{ animationDelay: "300ms" }}
                                  />
                                </span>
                                正在输入...
                              </div>
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                </div>
  );
}
