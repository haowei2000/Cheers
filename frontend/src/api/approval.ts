import { apiJson } from "./client";

// ACP per-operation approval (docs/arch/ACP_APPROVAL_FLOW.md).

export interface ApproverInfo {
  user_id: string;
  granted_by: string;
  granted_at: string;
}

export interface ApproversResponse {
  owner_id: string | null;
  delegates: ApproverInfo[];
}

export interface AuditEvent {
  event_type: string;
  bot_id?: string | null;
  request_id?: string | null;
  msg_id?: string | null;
  actor_id?: string | null;
  target_user_id?: string | null;
  decision?: string | null;
  option_id?: string | null;
  detail?: unknown;
  created_at: string;
}

/** Resolve a pending ACP permission request (allow/reject by option_id). */
export async function resolvePermission(
  channelId: string,
  requestId: string,
  optionId: string
): Promise<{ ok: boolean; delivered: boolean; decision: string }> {
  return apiJson(
    `/channels/${channelId}/permissions/${encodeURIComponent(requestId)}/resolve`,
    { method: "POST", body: JSON.stringify({ option_id: optionId }) }
  );
}

/** Request approver rights for a pending permission (any channel member). */
export async function requestApprovalAccess(
  channelId: string,
  requestId: string
): Promise<{ ok: boolean }> {
  return apiJson(
    `/channels/${channelId}/permissions/${encodeURIComponent(
      requestId
    )}/request-access`,
    { method: "POST" }
  );
}

export async function listApprovers(
  botId: string,
  channelId: string
): Promise<ApproversResponse> {
  return apiJson(`/bots/${botId}/approvers?channel_id=${channelId}`);
}

export async function grantApprover(
  botId: string,
  channelId: string,
  userId: string
): Promise<{ ok: boolean }> {
  return apiJson(`/bots/${botId}/approvers`, {
    method: "POST",
    body: JSON.stringify({ channel_id: channelId, user_id: userId }),
  });
}

export async function revokeApprover(
  botId: string,
  channelId: string,
  userId: string
): Promise<{ ok: boolean }> {
  return apiJson(
    `/bots/${botId}/approvers/${userId}?channel_id=${channelId}`,
    { method: "DELETE" }
  );
}

export async function listApprovalAudit(
  channelId: string,
  limit = 100
): Promise<{ events: AuditEvent[] }> {
  return apiJson(`/channels/${channelId}/permissions/audit?limit=${limit}`);
}
