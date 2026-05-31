import { apiJson } from "./client";

export interface CapabilityRejectLogItem {
  log_id: number;
  bot_id: string;
  provider_account_id: string;
  delegation_id: string | null;
  decision_scope_type: string | null;
  decision_scope_id: string | null;
  frame_type: string;
  action: string | null;
  request_id: string | null;
  request_session_id: string | null;
  resolved_session_id: string | null;
  resolved_session_status: string | null;
  resolved_session_scope_type: string | null;
  resolved_session_scope_id: string | null;
  session_locator_source: string | null;
  session_locator_value: string | null;
  resource: string | null;
  decision_reason: string;
  created_at: string;
}

export interface CapabilityRejectLogMeta {
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
  next_page: number | null;
  previous_page: number | null;
}

export interface CapabilityRejectLogPage {
  items: CapabilityRejectLogItem[];
  meta: CapabilityRejectLogMeta;
}

export interface CapabilityRejectLogAdminQuery extends CapabilityRejectLogQuery {
  bot_id?: string;
}

export interface CapabilityRejectLogQuery {
  delegation_id?: string;
  start_at?: string;
  end_at?: string;
  page?: number;
  limit?: number;
}

export async function fetchCapabilityRejectLogs(
  botId: string,
  query: CapabilityRejectLogQuery = {},
): Promise<CapabilityRejectLogPage> {
  const params = new URLSearchParams();
  if (query.delegation_id) {
    params.set("delegation_id", query.delegation_id);
  }
  if (query.start_at) {
    params.set("start_at", query.start_at);
  }
  if (query.end_at) {
    params.set("end_at", query.end_at);
  }
  if (typeof query.page === "number") {
    params.set("page", String(query.page));
  }
  if (typeof query.limit === "number") {
    params.set("limit", String(query.limit));
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  return apiJson(`/bots/${botId}/capability-reject-logs${suffix}`);
}

export async function fetchCapabilityRejectLogsOps(
  query: CapabilityRejectLogAdminQuery = {},
): Promise<CapabilityRejectLogPage> {
  const params = new URLSearchParams();
  if (query.bot_id) {
    params.set("bot_id", query.bot_id);
  }
  if (query.delegation_id) {
    params.set("delegation_id", query.delegation_id);
  }
  if (query.start_at) {
    params.set("start_at", query.start_at);
  }
  if (query.end_at) {
    params.set("end_at", query.end_at);
  }
  if (typeof query.page === "number") {
    params.set("page", String(query.page));
  }
  if (typeof query.limit === "number") {
    params.set("limit", String(query.limit));
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  return apiJson(`/ops/capability-reject-logs${suffix}`);
}
