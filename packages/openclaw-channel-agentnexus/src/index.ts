/**
 * OpenClaw channel plugin entry —— 按 sdk-channel-plugins 官方契约。
 *
 * registerFull 里注册自 loopback HTTP 路由：WS 入站时 onMessage 会 fetch 这条路由，
 * 路由 handler 运行在 gateway-request-scope，合法调用 api.runtime.subagent.run。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { defineChannelPluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";

import {
  agentnexusPlugin,
  emitRunTrace,
  getSharedApi,
  installAgentEventForwarder,
  registerOpenClawRunTrace,
  setSharedApi,
  type ResolvedAccount,
} from "./plugin.js";

const INBOUND_PATH = "/plugins/agentnexus/inbound";

interface InboundBody {
  accountId: string;
  sessionKey: string;
  channelId: string;
  taskId: string;
  placeholderMsgId?: string | null;
  text: string;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as T;
}

function resolveGatewayPort(api: OpenClawPluginApi): number {
  const cfg = api.config as { gateway?: { port?: number } } | undefined;
  return cfg?.gateway?.port ?? 18789;
}

function resolveGatewayToken(api: OpenClawPluginApi): string | null {
  const cfg = api.config as { gateway?: { auth?: { mode?: string; token?: string } } } | undefined;
  const a = cfg?.gateway?.auth;
  if (a?.mode === "token" && typeof a.token === "string" && a.token.length > 0) {
    return a.token;
  }
  return null;
}

export default defineChannelPluginEntry<typeof agentnexusPlugin>({
  id: "agentnexus",
  name: "AgentNexus",
  description: "Slack-like multi-channel chat with bots (per-bot WebSocket bridge).",
  plugin: agentnexusPlugin,

  registerFull(api) {
    const internalToken = randomUUID();
    const port = resolveGatewayPort(api);
    const gatewayToken = resolveGatewayToken(api);
    setSharedApi(api, port, internalToken, gatewayToken);
    installAgentEventForwarder(api);

    api.logger.info(
      `agentnexus: registerFull registered HTTP route ${INBOUND_PATH} port=${port} gatewayTokenConfigured=${Boolean(gatewayToken)}`,
    );

    api.registerHttpRoute({
      path: INBOUND_PATH,
      // auth="gateway"：让 gateway 做外层 bearer 校验（用 api.config.gateway.auth.token
      // 的共享密钥），同时为此路由注入 operator.write scope，subagent.run 才能合法调用。
      // auth="plugin" 时 gateway 不注入 scope，subagent.run 会 500。
      auth: "gateway",
      match: "exact",
      replaceExisting: true,
      gatewayRuntimeScopeSurface: "write-default",
      handler: async (rawReq, rawRes) => {
        const req = rawReq as IncomingMessage;
        const res = rawRes as ServerResponse;

        // 注意：registerFull 会被多次调用（config reload），每次都重新随机
        // 生成 internalToken 并 setSharedApi；如果我们这里从闭包里拿，就和
        // WS 侧 getSharedApi() 拿到的可能不一致。所以必须 request 时才读。
        const expected = getSharedApi().internalToken;
        const token = req.headers?.["x-agentnexus-internal-token"];
        if (!expected || !token || token !== expected) {
          res.statusCode = 401;
          res.end("unauthorized");
          return true;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("method not allowed");
          return true;
        }

        let body: InboundBody;
        try {
          body = await readJsonBody<InboundBody>(req);
        } catch (err) {
          res.statusCode = 400;
          res.end(`bad json: ${String(err)}`);
          return true;
        }

        // 此 handler 运行在 gateway-request-scope —— subagent.run + session-binding 合法
        try {
          // runId normally equals idempotencyKey (= taskId). Register before
          // subagent.run so early lifecycle events have a target to forward to.
          registerOpenClawRunTrace({
            runId: body.taskId,
            accountId: body.accountId,
            sessionKey: body.sessionKey,
            channelId: body.channelId,
            taskId: body.taskId,
            placeholderMsgId: body.placeholderMsgId ?? null,
          });

          // Step 1: session binding（承诺 sessionKey → conversation）
          await getSessionBindingService().bind({
            targetSessionKey: body.sessionKey,
            targetKind: "subagent",
            conversation: {
              channel: "agentnexus",
              accountId: body.accountId,
              conversationId: body.taskId,
            },
            placement: "current",
          });

          // Step 2: 更新 session entry 的 last route —— deliver:true 从这里读
          //   {channel, to, accountId, threadId} 来决定把 agent 回复发到哪个 plugin
          const sessRT = api.runtime.channel?.session;
          if (sessRT?.resolveStorePath && sessRT?.updateLastRoute) {
            try {
              const storePath = sessRT.resolveStorePath();
              await sessRT.updateLastRoute({
                storePath,
                sessionKey: body.sessionKey,
                channel: "agentnexus",
                to: body.taskId,
                accountId: body.accountId,
              });
            } catch (e) {
              api.logger.warn(`agentnexus: updateLastRoute failed: ${String(e)}`);
            }
          } else {
            api.logger.warn("agentnexus: api.runtime.channel.session not available; deliver may not route back");
          }

          const { runId } = await api.runtime.subagent.run({
            sessionKey: body.sessionKey,
            message: body.text,
            deliver: true,
            idempotencyKey: body.taskId,
          });
          if (runId !== body.taskId) {
            registerOpenClawRunTrace({
              runId,
              accountId: body.accountId,
              sessionKey: body.sessionKey,
              channelId: body.channelId,
              taskId: body.taskId,
              placeholderMsgId: body.placeholderMsgId ?? null,
            });
          }
          emitRunTrace(runId, {
            stream: "agentnexus_plugin",
            ts: Date.now(),
            phase: "subagent_run_started",
            status: "running",
            title: "OpenClaw run started",
            message: `runId=${runId}`,
            data: { runId },
          });
          api.logger.info(
            `agentnexus: inbound→subagent.run runId=${runId} sk=${body.sessionKey} task=${body.taskId}`,
          );
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, runId }));
        } catch (err) {
          emitRunTrace(body.taskId, {
            stream: "agentnexus_plugin",
            ts: Date.now(),
            phase: "subagent_run_error",
            status: "failed",
            title: "OpenClaw run failed",
            message: String(err),
          });
          api.logger.error(`agentnexus: subagent.run failed: ${String(err)}`);
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return true;
      },
    });
  },
});

// 库导出：独立模式的用户可以直接拿 BotSession
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
  TraceFrame,
  ResumeFrame,
  ResumeAck,
} from "./types.js";
export {
  WS_CLOSE_AUTH_FAIL,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_BOT_UNAVAILABLE,
} from "./types.js";
export type { ResolvedAccount } from "./plugin.js";
