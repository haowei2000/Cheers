/**
 * 包主入口：标准 import from "openclaw-channel-agentnexus"。
 *
 * 不依赖 OpenClaw 运行时 —— 使用者可以只用 BotSession 作为普通 WS 客户端。
 * OpenClaw 的 bundled entry 在 ./entry/index.js（由 package.json#openclaw.extensions
 * 指向），走 `openclaw plugins install` 通道。
 */
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
