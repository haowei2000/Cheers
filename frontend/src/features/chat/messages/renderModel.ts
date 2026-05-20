import type {
  ChannelBot,
  ChannelUser,
  ClarifySchema,
  CurrentUser,
  Message,
} from "../../../types";
import {
  formatDayLabel,
  parseQuotePrefix,
  stripLeadingQuotePrefixes,
  TOPIC_DISPLAY_THRESHOLD,
} from "../../../lib/message";
import {
  isClarifyReplyUserMessage,
  parseHelperPayload,
} from "../../../lib/helper";

export const TOPIC_MAIN_LIST_REPLY_LIMIT = 20;

export type MessageRenderKind =
  | "day-divider"
  | "message"
  | "inline-reply"
  | "topic-chip"
  | "topic-reply";

export type MessageRenderItem =
  | {
      kind: "day-divider";
      key: string;
      dayLabel: string;
      msgId?: undefined;
      rootId?: undefined;
    }
  | {
      kind: "message";
      key: string;
      msgId: string;
      rootId: string;
      message: Message;
    }
  | {
      kind: "inline-reply";
      key: string;
      msgId: string;
      rootId: string;
      message: Message;
    }
  | {
      kind: "topic-chip";
      key: string;
      msgId: string;
      rootId: string;
      message: Message;
      replies: Message[];
      expanded: boolean;
      hiddenReplyCount: number;
    }
  | {
      kind: "topic-reply";
      key: string;
      msgId: string;
      rootId: string;
      message: Message;
      hiddenBefore: boolean;
    };

export type TopicRepliesOf = (rootId: string) => Message[];
export type RootIdOf = (msgId: string) => string | undefined;

export interface ChatRenderModel {
  topicRoots: Message[];
  topicRepliesOf: TopicRepliesOf;
  rootIdOf: RootIdOf;
  msgById: Map<string, Message>;
  clarifyAnsweredParentIds: Set<string>;
  renderItems: MessageRenderItem[];
}

export interface MessageViewModel {
  message: Message;
  isOwn: boolean;
  isBot: boolean;
  senderLabel: string;
  senderBot?: ChannelBot;
  senderUser?: ChannelUser;
  avatarUrl?: string | null;
  initials: string;
  time: string;
  effectiveContent: string;
  text: string;
  displayContent: string;
  bodyContent: string;
  quote: ReturnType<typeof parseQuotePrefix>;
  clarify?: ClarifySchema;
  clarifyStatus: "form" | "waiting" | "answered" | null;
  secretRevealedContent?: string;
  isSecretExpired: boolean;
  isSecretUnrevealed: boolean;
}

const ROOT_ONLY_KINDS = new Set(["routing", "permission", "announcement"]);
const DELETED_MESSAGE_TEXT = "This message was deleted.";

function compareMessagesByCreatedAt(a: Message, b: Message): number {
  const parsedATime = a.created_at ? Date.parse(a.created_at) : 0;
  const parsedBTime = b.created_at ? Date.parse(b.created_at) : 0;
  const aTime = Number.isFinite(parsedATime) ? parsedATime : 0;
  const bTime = Number.isFinite(parsedBTime) ? parsedBTime : 0;
  if (aTime !== bTime) return aTime - bTime;
  return a.msg_id.localeCompare(b.msg_id);
}

function isReply(message: Message, msgIdSet: Set<string>): boolean {
  if (message.msg_type === "reply") return true;
  if (message.msg_type && ROOT_ONLY_KINDS.has(message.msg_type)) return false;
  return Boolean(message.in_reply_to_msg_id && msgIdSet.has(message.in_reply_to_msg_id));
}

function appendDayDivider(
  items: MessageRenderItem[],
  message: Message,
  lastDayRef: { value: string },
): void {
  const day = formatDayLabel(message.created_at);
  if (!day || day === lastDayRef.value) return;
  lastDayRef.value = day;
  items.push({
    kind: "day-divider",
    key: `day:${day}:${message.msg_id}`,
    dayLabel: day,
  });
}

function visibleTopicReplies(
  replies: Message[],
  focusedMsgId: string | null,
): { replies: Message[]; hiddenReplyCount: number; hiddenBefore: boolean } {
  if (replies.length <= TOPIC_MAIN_LIST_REPLY_LIMIT) {
    return { replies, hiddenReplyCount: 0, hiddenBefore: false };
  }

  const tail = replies.slice(-TOPIC_MAIN_LIST_REPLY_LIMIT);
  if (!focusedMsgId || tail.some((message) => message.msg_id === focusedMsgId)) {
    return {
      replies: tail,
      hiddenReplyCount: replies.length - tail.length,
      hiddenBefore: true,
    };
  }

  const focused = replies.find((message) => message.msg_id === focusedMsgId);
  if (!focused) {
    return {
      replies: tail,
      hiddenReplyCount: replies.length - tail.length,
      hiddenBefore: true,
    };
  }

  const merged = [
    focused,
    ...tail.filter((message) => message.msg_id !== focused.msg_id),
  ].slice(0, TOPIC_MAIN_LIST_REPLY_LIMIT);
  return {
    replies: merged.sort(compareMessagesByCreatedAt),
    hiddenReplyCount: Math.max(0, replies.length - merged.length),
    hiddenBefore: true,
  };
}

export function buildChatRenderModel(
  messages: Message[],
  isDmSelected: boolean,
  expandedTopics: Set<string>,
  focusedMsgId: string | null = null,
): ChatRenderModel {
  const msgIdSet = new Set(messages.map((message) => message.msg_id));
  const msgById = new Map(messages.map((message) => [message.msg_id, message]));
  const rootIdCache = new Map<string, string>();

  const getRootId = (msgId: string): string => {
    const cached = rootIdCache.get(msgId);
    if (cached) return cached;
    const message = msgById.get(msgId);
    if (!message || !isReply(message, msgIdSet) || !message.in_reply_to_msg_id) {
      rootIdCache.set(msgId, msgId);
      return msgId;
    }
    const rootId = getRootId(message.in_reply_to_msg_id);
    rootIdCache.set(msgId, rootId);
    return rootId;
  };

  const replyMap = new Map<string, Message[]>();
  const replySet = new Set<string>();
  const clarifyAnsweredParentIds = new Set<string>();

  for (const message of messages) {
    if (
      message.in_reply_to_msg_id &&
      isClarifyReplyUserMessage(message.content)
    ) {
      clarifyAnsweredParentIds.add(message.in_reply_to_msg_id);
    }

    const rootId = getRootId(message.msg_id);
    if (rootId === message.msg_id) continue;
    const root = msgById.get(rootId);
    if (isDmSelected && root?.msg_type !== "topic") continue;
    replySet.add(message.msg_id);
    const replies = replyMap.get(rootId) ?? [];
    replies.push(message);
    replyMap.set(rootId, replies);
  }

  for (const replies of replyMap.values()) {
    replies.sort(compareMessagesByCreatedAt);
  }

  const topicRoots = messages.filter((message) => !replySet.has(message.msg_id));
  const renderItems: MessageRenderItem[] = [];
  const lastDayRef = { value: "" };

  for (const root of topicRoots) {
    appendDayDivider(renderItems, root, lastDayRef);
    const replies = replyMap.get(root.msg_id) ?? [];
    const explicitTopic = !isDmSelected && root.msg_type === "topic";
    const promotedTopic =
      !isDmSelected && replies.length >= TOPIC_DISPLAY_THRESHOLD;

    if (!explicitTopic && !promotedTopic) {
      renderItems.push({
        kind: "message",
        key: `message:${root.msg_id}`,
        msgId: root.msg_id,
        rootId: root.msg_id,
        message: root,
      });
      for (const reply of replies) {
        renderItems.push({
          kind: "inline-reply",
          key: `inline-reply:${reply.msg_id}`,
          msgId: reply.msg_id,
          rootId: root.msg_id,
          message: reply,
        });
      }
      continue;
    }

    if (explicitTopic && replies.length === 0) {
      renderItems.push({
        kind: "message",
        key: `message:${root.msg_id}`,
        msgId: root.msg_id,
        rootId: root.msg_id,
        message: root,
      });
      continue;
    }

    const expanded =
      expandedTopics.has(root.msg_id) ||
      Boolean(focusedMsgId && getRootId(focusedMsgId) === root.msg_id);
    const visible = visibleTopicReplies(replies, focusedMsgId);
    renderItems.push({
      kind: "topic-chip",
      key: `topic-chip:${root.msg_id}:${expanded ? "open" : "closed"}`,
      msgId: root.msg_id,
      rootId: root.msg_id,
      message: root,
      replies,
      expanded,
      hiddenReplyCount: expanded ? visible.hiddenReplyCount : replies.length,
    });

    if (!expanded) continue;
    for (const reply of visible.replies) {
      renderItems.push({
        kind: "topic-reply",
        key: `topic-reply:${reply.msg_id}`,
        msgId: reply.msg_id,
        rootId: root.msg_id,
        message: reply,
        hiddenBefore: visible.hiddenBefore,
      });
    }
  }

  return {
    topicRoots,
    topicRepliesOf: (rootId: string) => replyMap.get(rootId) ?? [],
    rootIdOf: (msgId: string) => rootIdCache.get(msgId),
    msgById,
    clarifyAnsweredParentIds,
    renderItems,
  };
}

export function createMessageViewModel({
  message,
  botById,
  userById,
  currentUser,
  currentUserId,
  revealedContent,
  clarifyAnsweredParentIds,
  pendingClarifyReplyMsgId,
  formatTime,
}: {
  message: Message;
  botById: Map<string, ChannelBot>;
  userById: Map<string, ChannelUser>;
  currentUser: CurrentUser;
  currentUserId: string | null;
  revealedContent?: string;
  clarifyAnsweredParentIds: Set<string>;
  pendingClarifyReplyMsgId: string | null;
  formatTime: (iso: string | undefined, compact?: boolean) => string;
}): MessageViewModel {
  const isDeleted = Boolean(message.is_deleted);
  const effectiveContent = message.is_secret
    ? (revealedContent ?? message.content)
    : message.content;
  const { text, clarify } = isDeleted
    ? { text: DELETED_MESSAGE_TEXT, clarify: undefined }
    : parseHelperPayload(effectiveContent);
  const isOwn =
    message.sender_type === "user" && message.sender_id === currentUserId;
  const senderBot =
    message.sender_type === "bot" ? botById.get(message.sender_id) : undefined;
  const senderUser =
    message.sender_type === "user" && !isOwn
      ? userById.get(message.sender_id)
      : undefined;
  const senderLabel =
    message.sender_name ||
    (message.sender_type === "bot"
      ? senderBot?.display_name || senderBot?.username || "Bot"
      : isOwn
        ? currentUser?.display_name || currentUser?.username || "Me"
        : senderUser?.display_name || senderUser?.username || "User");
  const displayBase = isDeleted
    ? DELETED_MESSAGE_TEXT
    : isClarifyReplyUserMessage(effectiveContent)
    ? effectiveContent
        .replace(
          /^@(?:Helper|Coordinator|channel bot|\u5f15\u5bfc)\s*(?:Clarification answer|\u6f84\u6e05\u56de\u7b54)[\uFF1A:]\s*/i,
          "",
        )
        .trim()
    : clarify
    ? text
    : text || effectiveContent;
  const displayContent =
    message.sender_type === "bot"
      ? stripLeadingQuotePrefixes(displayBase)
      : displayBase;
  const quote = parseQuotePrefix(displayContent);
  const clarifyAnswered =
    Boolean(clarify) && clarifyAnsweredParentIds.has(message.msg_id);
  const clarifyWaiting = pendingClarifyReplyMsgId === message.msg_id;
  const clarifyStatus =
    !isDeleted && clarify && message.sender_type === "bot"
      ? clarifyWaiting
        ? "waiting"
        : clarifyAnswered
          ? "answered"
          : "form"
      : null;

  return {
    message,
    isOwn,
    isBot: message.sender_type === "bot",
    senderLabel,
    senderBot,
    senderUser,
    avatarUrl: isOwn ? currentUser?.avatar_url : senderUser?.avatar_url,
    initials: (isOwn ? "Me" : senderLabel.slice(0, 2).toUpperCase()) || "U",
    time: formatTime(message.created_at),
    effectiveContent: isDeleted ? DELETED_MESSAGE_TEXT : effectiveContent,
    text,
    displayContent,
    bodyContent: quote?.rest ?? displayContent,
    quote,
    clarify,
    clarifyStatus,
    secretRevealedContent: revealedContent,
    isSecretExpired: false,
    isSecretUnrevealed: false,
  };
}
