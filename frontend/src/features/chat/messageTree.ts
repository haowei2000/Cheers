import type { Message, PermissionContentData } from "@/types";

/** Keep compact message grouping local to a short, uninterrupted exchange.
 *  Older messages and replies need their own author header so the timeline does
 *  not turn into an anonymous wall of text. */
export const CONSECUTIVE_MESSAGE_WINDOW_MS = 5 * 60 * 1000;
export const DISCUSSION_CONSECUTIVE_WINDOW_MS = 30 * 60 * 1000;

export function isVisuallyConsecutive(
  previous: Message,
  current: Message,
  maxGapMs = CONSECUTIVE_MESSAGE_WINDOW_MS,
): boolean {
  const previousIsNormal = !previous.msg_type || previous.msg_type === "normal";
  const currentIsNormal = !current.msg_type || current.msg_type === "normal";
  if (
    !previousIsNormal ||
    !currentIsNormal ||
    previous.sender_id !== current.sender_id ||
    previous.sender_type !== current.sender_type ||
    previous.is_deleted ||
    current.is_deleted ||
    previous.reply_to_msg_id ||
    current.reply_to_msg_id
  ) {
    return false;
  }

  const previousAt = Date.parse(previous.created_at ?? "");
  const currentAt = Date.parse(current.created_at ?? "");
  if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt)) return false;

  const gap = currentAt - previousAt;
  return gap >= 0 && gap <= maxGapMs;
}

/** Discuss threads may span a slower editorial exchange. Collapse repeated
 * identity chrome only when sender and reply target are unchanged. */
export function isDiscussionConsecutive(
  previous: Message,
  current: Message,
  maxGapMs = DISCUSSION_CONSECUTIVE_WINDOW_MS,
): boolean {
  const previousIsNormal = !previous.msg_type || previous.msg_type === "normal";
  const currentIsNormal = !current.msg_type || current.msg_type === "normal";
  if (
    !previousIsNormal ||
    !currentIsNormal ||
    previous.sender_id !== current.sender_id ||
    previous.sender_type !== current.sender_type ||
    previous.reply_to_msg_id !== current.reply_to_msg_id ||
    previous.is_deleted ||
    current.is_deleted
  ) return false;

  const previousAt = Date.parse(previous.created_at ?? "");
  const currentAt = Date.parse(current.created_at ?? "");
  if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt)) return false;
  const gap = currentAt - previousAt;
  return gap >= 0 && gap <= maxGapMs;
}

/** Approvals anchored to a bot turn render inside Agent steps, not as channel rows. */
export function isFoldedPermission(m: Message): boolean {
  if (m.msg_type !== "permission") return false;
  const source = (m.content_data as PermissionContentData | null | undefined)
    ?.source_msg_id;
  return typeof source === "string" && source.length > 0;
}

export function permissionSourceId(m: Message): string | null {
  const source = (m.content_data as PermissionContentData | null | undefined)
    ?.source_msg_id;
  return typeof source === "string" && source.length > 0 ? source : null;
}

export function messageSessionId(m: Message): string | null {
  const data = m.content_data as Record<string, unknown> | null | undefined;
  const sid = data?.session_id;
  return typeof sid === "string" && sid.length > 0 ? sid : null;
}

/**
 * Split a loaded message window into top-level roots and children keyed by parent.
 * A message with `reply_to_msg_id` pointing at another loaded (non-folded) message
 * is a sub-message; otherwise it stays a root (orphan reply when parent isn't loaded).
 * Folded permissions are excluded from both roots and children.
 */
export function groupMessagesByReply(messages: Message[]): {
  roots: Message[];
  childrenByParent: Map<string, Message[]>;
  byId: Map<string, Message>;
} {
  const byId = new Map<string, Message>();
  for (const msg of messages) {
    if (isFoldedPermission(msg)) continue;
    byId.set(msg.msg_id, msg);
  }

  const childrenByParent = new Map<string, Message[]>();
  const roots: Message[] = [];

  for (const msg of messages) {
    if (isFoldedPermission(msg)) continue;
    const parentId = msg.reply_to_msg_id;
    if (parentId && byId.has(parentId) && parentId !== msg.msg_id) {
      const list = childrenByParent.get(parentId);
      if (list) list.push(msg);
      else childrenByParent.set(parentId, [msg]);
    } else {
      roots.push(msg);
    }
  }

  // Keep each sibling list in channel order (stable: messages already sorted).
  for (const [, kids] of childrenByParent) {
    kids.sort((a, b) => (a.channel_seq ?? 0) - (b.channel_seq ?? 0));
  }

  return { roots, childrenByParent, byId };
}
