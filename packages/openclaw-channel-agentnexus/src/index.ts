/**
 * OpenClaw channel plugin entry following the sdk-channel-plugins contract.
 *
 * registerFull registers a loopback HTTP route. When WebSocket inbound
 * messages arrive, onMessage fetches this route. The route handler runs in
 * gateway-request-scope and may legally call api.runtime.subagent.run.
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
  notifyOpenClawRunTerminal,
  registerOpenClawRunTrace,
  setSharedApi,
  type ResolvedAccount,
} from "./plugin.js";

const INBOUND_PATH = "/plugins/agentnexus/inbound";
const RUN_COMPLETION_WAIT_TIMEOUT_MS = 48 * 60 * 60 * 1000;

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

function agentIdFromSessionKey(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] || null;
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
      // auth="gateway" lets the gateway validate the outer bearer token with
      // api.config.gateway.auth.token and inject operator.write scope for this
      // route, which is required for subagent.run. With auth="plugin", gateway
      // does not inject scope and subagent.run returns 500.
      auth: "gateway",
      match: "exact",
      replaceExisting: true,
      gatewayRuntimeScopeSurface: "write-default",
      handler: async (rawReq, rawRes) => {
        const req = rawReq as IncomingMessage;
        const res = rawRes as ServerResponse;

        // registerFull may be called multiple times during config reloads. Each
        // call creates a new internalToken and calls setSharedApi. Reading from
        // this closure may diverge from the WebSocket side, so read per request.
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

        // This handler runs in gateway-request-scope, so subagent.run and
        // session binding are allowed.
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

          // Step 1: bind sessionKey to the conversation.
          await getSessionBindingService().bind({
            targetSessionKey: body.sessionKey,
            targetKind: "subagent",
            conversation: {
              channel: "agentnexus",
              accountId: body.accountId,
              conversationId: body.taskId,
            },
            placement: "current",
            metadata: {
              agentnexusTaskId: body.taskId,
              placeholderMsgId: body.placeholderMsgId ?? null,
              channelId: body.channelId,
              sessionKey: body.sessionKey,
            },
          });

          // Step 2: update the session entry's last route. deliver:true reads
          // {channel, to, accountId, threadId} here to choose the plugin target
          // for agent replies.
          const sessRT = api.runtime.channel?.session;
          if (sessRT?.resolveStorePath && sessRT?.updateLastRoute) {
            try {
              const agentId = agentIdFromSessionKey(body.sessionKey);
              const storePath = agentId
                ? sessRT.resolveStorePath(undefined, { agentId })
                : sessRT.resolveStorePath();
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
          void api.runtime.subagent.waitForRun({
            runId,
            timeoutMs: RUN_COMPLETION_WAIT_TIMEOUT_MS,
          }).then((result) => {
            notifyOpenClawRunTerminal({
              runId,
              accountId: body.accountId,
              taskId: body.taskId,
              status: result.status,
              error: result.error ?? null,
            }, api.logger);
          }).catch((err) => {
            api.logger.warn(`agentnexus: waitForRun failed runId=${runId}: ${String(err)}`);
          });
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

// Library exports for standalone users that want BotSession directly.
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
