import type { Message } from "../types";

export function isMsgReply(
  m: Message | undefined,
  msgIdSet: Set<string>,
): boolean {
  if (!m) return false;
  return (
    m.msg_type === "reply" ||
    (!m.msg_type && !!m.in_reply_to_msg_id && msgIdSet.has(m.in_reply_to_msg_id))
  );
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
