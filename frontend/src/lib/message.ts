import type { Message } from "../types";

/**
 * A conversation only becomes a "message thread" (对话串) once this many
 * direct replies have accumulated under the root. Below the threshold,
 * replies render as plain inline messages under the root — no dock,
 * no thread card. Keep this in sync with the backend constant
 * THREAD_PROMOTE_THRESHOLD in
 * backend/app/services/orchestrator/thread_context.py.
 */
export const THREAD_DISPLAY_THRESHOLD = 4;

/**
 * Decide whether a message should be grouped as a reply (i.e. rendered
 * inside its parent's thread instead of as its own root).
 *
 * Kinds that are explicitly NOT replies: routing cards, permission
 * cards, and announcements — those are channel-level roots even when a
 * backend adapter set in_reply_to_msg_id on them. Everything else that
 * points at a known parent message is a reply, regardless of whether
 * msg_type is "reply", "thread", "normal" or missing. This is more
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

const QUOTE_PREFIX_RE = /^> \[([^\]]+)\]: ([\s\S]+?)\n\n([\s\S]*)$/;

export function parseQuotePrefix(
  text: string,
): { label: string; quote: string; rest: string } | null {
  const m = QUOTE_PREFIX_RE.exec(text);
  if (!m) return null;
  return { label: m[1], quote: m[2], rest: m[3] };
}

export function formatTs(ts?: string): string {
  return (ts || "").slice(0, 19);
}
