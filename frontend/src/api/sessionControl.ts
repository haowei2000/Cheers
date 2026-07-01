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
  /** Per-session mode/config overrides (set via set_mode / set_config_option). */
  session_config?: {
    permission_mode?: string;
    config_options?: Record<string, string>;
  };
}

export async function listChannelBotSessions(
  channelId: string,
  botId: string
): Promise<{ sessions: SessionInfo[] }> {
  return apiJson(`/channels/${channelId}/bots/${botId}/sessions`);
}

/** The per-session ACP root set: primary working dir + extra accessible roots. */
export interface SessionWorkspace {
  /** Absolute working directory (ACP `cwd`). Omit to use the connector default. */
  cwd?: string;
  /** Absolute extra roots (ACP `additionalDirectories`). */
  additional_dirs?: string[];
}

export async function createChannelBotSession(
  channelId: string,
  botId: string,
  workspace?: SessionWorkspace
): Promise<{
  session_id: string;
  provider_session_key: string;
  role: string;
  cwd: string | null;
  additional_dirs: string[];
}> {
  const hasWorkspace =
    workspace && (workspace.cwd || (workspace.additional_dirs?.length ?? 0) > 0);
  return apiJson(`/channels/${channelId}/bots/${botId}/sessions`, {
    method: "POST",
    ...(hasWorkspace ? { body: JSON.stringify(workspace) } : {}),
  });
}

/** Close (terminate + detach) an "other" session — gated by the session_close grant. */
export async function closeChannelBotSession(
  channelId: string,
  botId: string,
  sessionId: string
): Promise<void> {
  await apiJson(`/channels/${channelId}/bots/${botId}/sessions/${sessionId}`, { method: "DELETE" });
}

/** The CALLER's resolved grants + the agent's advertised vocabulary (no rules leak). */
export interface SessionControls {
  can_set_mode: boolean;
  can_set_config_option: boolean;
  can_create_session: boolean;
  can_close_session: boolean;
  allowed_modes: string[];
  /** The agent's preset mode — the effective mode when no per-session override is set. */
  current_mode?: string;
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

/**
 * Replace a session's ACP `additionalDirectories` (the mutable root-set lever).
 * `cwd` is immutable and cannot be changed here; the new set takes effect on the
 * session's next interaction. Gated like set_config_option.
 */
export async function setSessionAdditionalDirs(
  channelId: string,
  botId: string,
  sessionId: string,
  additionalDirs: string[]
): Promise<{ ok: boolean; additional_dirs: string[] }> {
  return apiJson(`/channels/${channelId}/bots/${botId}/sessions/${sessionId}/workspace`, {
    method: "PUT",
    body: JSON.stringify({ additional_dirs: additionalDirs }),
  });
}
