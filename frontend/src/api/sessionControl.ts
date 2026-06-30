import { apiJson } from "./client";
import type { ConfigOption } from "./bots";

// Per-channel session management + delegated session-scoped mode/config changes
// (docs/arch/SESSION_MODEL.md). Visible to channel members; mutations are gated
// server-side by acp_policy INITIATE grants (fail-closed).

export interface SessionInfo {
  session_id: string;
  role: string;
  is_primary: boolean;
  status: string;
  last_used_at: string;
}

export async function listChannelBotSessions(
  channelId: string,
  botId: string
): Promise<{ sessions: SessionInfo[] }> {
  return apiJson(`/channels/${channelId}/bots/${botId}/sessions`);
}

export async function createChannelBotSession(
  channelId: string,
  botId: string
): Promise<{ session_id: string; provider_session_key: string; role: string }> {
  return apiJson(`/channels/${channelId}/bots/${botId}/sessions`, { method: "POST" });
}

/** The CALLER's resolved grants + the agent's advertised vocabulary (no rules leak). */
export interface SessionControls {
  can_set_mode: boolean;
  can_set_config_option: boolean;
  allowed_modes: string[];
  config_options: ConfigOption[];
}

export async function getSessionControls(
  channelId: string,
  botId: string
): Promise<SessionControls> {
  return apiJson(`/channels/${channelId}/bots/${botId}/session-controls`);
}

export async function setSessionMode(
  channelId: string,
  botId: string,
  sessionId: string,
  mode: string
): Promise<void> {
  await apiJson(`/channels/${channelId}/bots/${botId}/sessions/${sessionId}/mode`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export async function setSessionConfigOption(
  channelId: string,
  botId: string,
  sessionId: string,
  config_id: string,
  value: string
): Promise<void> {
  await apiJson(`/channels/${channelId}/bots/${botId}/sessions/${sessionId}/config-option`, {
    method: "POST",
    body: JSON.stringify({ config_id, value }),
  });
}
