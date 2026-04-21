/**
 * 主入口：真实 OpenClaw SDK 会从这里加载 plugin 定义。
 *
 * 等价于 docs 里示例的：
 *   defineChannelPluginEntry({ id, name, description, plugin })
 */
import { agentnexusPlugin } from "./plugin.js";
import { defineChannelPluginEntry } from "./sdk-shim.js";

export default defineChannelPluginEntry({
  id: "agentnexus",
  name: "AgentNexus",
  description: "Slack-like multi-channel chat with bots (per-bot WS bridge).",
  plugin: agentnexusPlugin,
});

// 同时导出内部实现，方便在 openclaw SDK 外单独使用（例如作为普通 Node 客户端）。
export { BotSession, type InboundMessage, type SessionConfig, type SessionEvents, type SendResult } from "./session.js";
export { agentnexusPlugin } from "./plugin.js";
export { isFatalCloseCode, computeBackoff } from "./reconnect.js";
export type {
  ChannelInfo,
  ControlInbound,
  DataInbound,
  MessageEvent,
  ReplyFrame,
  SendFrame,
  SendAck,
  SendAckOk,
  SendAckErr,
  TriggerMessage,
  AttachmentInfo,
  ResumeFrame,
  ResumeAck,
} from "./types.js";
export {
  WS_CLOSE_AUTH_FAIL,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_BOT_UNAVAILABLE,
} from "./types.js";
