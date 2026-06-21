import { apiJson } from "./client";
import type { BotItem } from "@/types";

export async function listBots(): Promise<BotItem[]> {
  return apiJson<BotItem[]>("/bots");
}

export interface CreateBotInput {
  username: string;
  display_name?: string;
  intro?: string;
  /** When set, the Agent Bridge requires a signed ACP capability delegation. */
  acp_security?: { enabled: boolean; require_capability?: boolean };
}

export async function createBot(input: CreateBotInput): Promise<BotItem> {
  return apiJson<BotItem>("/bots", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface IssuedToken {
  bot_id: string;
  token: string;
  token_prefix: string;
  note?: string;
}

/** Issue/rotate the bot's Agent Bridge token. Plaintext is returned once. */
export async function issueBotToken(botId: string): Promise<IssuedToken> {
  return apiJson<IssuedToken>(`/bots/${botId}/token`, { method: "POST" });
}

export interface BotStatus {
  bot_id: string;
  status: string;
  is_online: boolean;
  connection_status?: string;
}

export async function getBotStatus(botId: string): Promise<BotStatus> {
  return apiJson<BotStatus>(`/bots/${botId}/status`);
}
