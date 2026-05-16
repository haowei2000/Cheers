import type { Message } from "../types";

/**
 * A conversation only becomes a topic once this many direct
 * replies have accumulated under the root. Below the threshold, replies
 * render as plain inline messages under the root — no dock, no topic
 * card. Keep this in sync with the backend constant
 * TOPIC_PROMOTE_THRESHOLD in
 * backend/app/services/orchestrator/topic_context.py.
 */
export const TOPIC_DISPLAY_THRESHOLD = 4;

/**
 * Decide whether a message should be grouped as a reply (i.e. rendered
 * inside its parent's topic instead of as its own root).
 *
 * Kinds that are explicitly NOT replies: routing cards, permission
 * cards, and announcements — those are channel-level roots even when a
 * backend adapter set in_reply_to_msg_id on them. Everything else that
 * points at a known parent message is a reply, regardless of whether
 * msg_type is "reply", "topic", "normal" or missing. This is more
 * permissive than an exact msg_type === "reply" check so that
 * round-tripped data (where msg_type defaults to "normal" on the wire)
 * still groups correctly after a page refresh.
 */
const ROOT_ONLY_KINDS = new Set(["routing", "permission", "announcement"]);

export function isMsgReply(
  m: Message | undefined,
  msgIdSet: Set<string>,
): boolean {
  if (!m) return false;
  if (m.msg_type === "reply") return true;
  if (m.msg_type && ROOT_ONLY_KINDS.has(m.msg_type)) return false;
  return !!m.in_reply_to_msg_id && msgIdSet.has(m.in_reply_to_msg_id);
}

function compareMessagesByCreatedAt(a: Message, b: Message): number {
  const parsedATime = a.created_at ? Date.parse(a.created_at) : 0;
  const parsedBTime = b.created_at ? Date.parse(b.created_at) : 0;
  const aTime = Number.isFinite(parsedATime) ? parsedATime : 0;
  const bTime = Number.isFinite(parsedBTime) ? parsedBTime : 0;
  if (aTime !== bTime) return aTime - bTime;
  return a.msg_id.localeCompare(b.msg_id);
}

export function mergeMessagesChronologically(
  ...messageLists: Message[][]
): Message[] {
  const byId = new Map<string, Message>();
  for (const list of messageLists) {
    for (const message of list) {
      const previous = byId.get(message.msg_id);
      const merged = {
        ...previous,
        ...message,
      };
      if (previous?._streaming && !message._streaming) {
        merged._streaming = true;
        if ((previous.content || "").length > (message.content || "").length) {
          merged.content = previous.content;
        }
      }
      byId.set(message.msg_id, merged);
    }
  }
  return Array.from(byId.values()).sort(compareMessagesByCreatedAt);
}

export function buildTopicTree(
  messages: Message[],
  isDmSelected: boolean,
): {
  topicRoots: Message[];
  topicRepliesOf: (rootId: string) => Message[];
} {
  const msgIdSet = new Set(messages.map((x) => x.msg_id));
  const msgById = new Map(messages.map((x) => [x.msg_id, x]));
  const rootIdCache = new Map<string, string>();
  function getRootId(msgId: string): string {
    if (rootIdCache.has(msgId)) return rootIdCache.get(msgId)!;
    const m = msgById.get(msgId);
    if (!m || !isMsgReply(m, msgIdSet) || !m.in_reply_to_msg_id) {
      rootIdCache.set(msgId, msgId);
      return msgId;
    }
    const rid = getRootId(m.in_reply_to_msg_id);
    rootIdCache.set(msgId, rid);
    return rid;
  }

  const replyMap = new Map<string, Message[]>();
  const replySet = new Set<string>();
  for (const m of messages) {
    const rootId = getRootId(m.msg_id);
    if (rootId !== m.msg_id) {
      const root = msgById.get(rootId);
      if (isDmSelected && root?.msg_type !== "topic") continue;
      replySet.add(m.msg_id);
      const arr = replyMap.get(rootId) ?? [];
      arr.push(m);
      replyMap.set(rootId, arr);
    }
  }
  for (const arr of replyMap.values()) {
    arr.sort(compareMessagesByCreatedAt);
  }
  return {
    topicRoots: messages.filter((m) => !replySet.has(m.msg_id)),
    topicRepliesOf: (rootId: string): Message[] => replyMap.get(rootId) ?? [],
  };
}

const QUOTE_PREFIX_RE = /^> \[([^\]]+)\]: ([\s\S]+?)\n\n([\s\S]*)$/;

export function parseQuotePrefix(
  text: string,
): { label: string; quote: string; rest: string } | null {
  const m = QUOTE_PREFIX_RE.exec(text);
  if (!m) return null;
  return { label: m[1], quote: m[2], rest: m[3] };
}

/**
 * Strip leading `> [Author]: ... \n` blockquote-prefix lines from content.
 * Called on bot-generated messages to remove the name-prefix format that
 * LLMs sometimes hallucinate when they've seen reply-quote prefixes in the
 * conversation history.
 */
export function stripLeadingQuotePrefixes(text: string): string {
  const cleaned = text.replace(/^(?:> \[[^\]]+\]: [^\n]*\n+)+/, "").trim();
  return cleaned || text;
}

export function formatTs(ts?: string): string {
  return (ts || "").slice(0, 19);
}

/**
 * Stable label for a day divider in the message stream:
 * - today label for the current day
 * - yesterday label for the previous day
 * - localized date otherwise
 *
 * Returns "" for missing / unparseable timestamps so the caller can
 * skip inserting a divider.
 */
export function formatDayLabel(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const now = new Date();
  const diffDays = Math.round(
    (startOf(d) - startOf(now)) / 86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === -1) return "Yesterday";
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
