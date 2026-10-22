import type { TaskClaimUpdate } from "@/api/taskClaims";
import type { Message } from "@/types";

type Data = Record<string, unknown>;
const object = (value: unknown): Data | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : null;
const revision = (data: Data) => typeof data.claim_revision === "number" &&
  Number.isSafeInteger(data.claim_revision) && data.claim_revision > 0 ? data.claim_revision : 0;
const claimFields = ["claim_id", "claim_revision", "claim_status", "resolved", "decision", "resolved_by", "resolution_note"];

/** Claim metadata is one versioned projection, regardless of HTTP, WS or history arrival order. */
export function mergeMessageContentData(current: Message["content_data"], incoming: Message["content_data"]): Message["content_data"] {
  if (incoming === undefined) return current;
  const previous = object(current);
  const next = object(incoming);
  if (typeof previous?.claim_id !== "string") return incoming;
  if (!next) return current;
  if (typeof next.claim_id === "string" && next.claim_id !== previous.claim_id) return current;
  const matchingClaim = next.claim_id === previous.claim_id;
  const newer = matchingClaim && revision(next) > revision(previous);
  const legacyResolution = revision(next) === 0 && revision(previous) === 0 &&
    matchingClaim && previous.resolved !== true && next.resolved === true;
  if (newer || legacyResolution) return { ...previous, ...next };
  const merged = { ...previous, ...next };
  for (const field of claimFields) {
    if (field in previous) merged[field] = previous[field];
    else delete merged[field];
  }
  return merged;
}

export function claimConfirmationUpdate(value: unknown, expectedChannelId: string): TaskClaimUpdate["confirmation_message"] {
  const update = object(value);
  const confirmation = object(update?.confirmation_message);
  const data = object(confirmation?.content_data);
  if (typeof update?.claim_id !== "string" || !update.claim_id || update.channel_id !== expectedChannelId ||
    typeof confirmation?.msg_id !== "string" || !confirmation.msg_id || data?.claim_id !== update.claim_id ||
    !["pending", "executing", "rejected", "cancelled", "failed", "completed"].includes(String(update.status)) ||
    data.claim_status !== update.status || revision(data) === 0 ||
    data.resolved !== (update.status !== "pending")) return null;
  return { msg_id: confirmation.msg_id, content_data: data };
}

/** Final statuses are immutable; older accepted cards still need their eventual outcome. */
export function needsClaimReconciliation(message: Message): boolean {
  if (message.is_deleted || message.msg_type !== "task_claim_confirmation" ||
    typeof message.channel_seq !== "number" || !Number.isSafeInteger(message.channel_seq) || message.channel_seq < 1) return false;
  const data = object(message.content_data);
  return typeof data?.claim_id === "string" &&
    !["rejected", "cancelled", "failed", "completed"].includes(String(data.claim_status ?? ""));
}
