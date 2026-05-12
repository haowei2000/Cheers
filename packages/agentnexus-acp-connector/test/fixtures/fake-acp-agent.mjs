import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const sessions = new Set();
const loadSession = process.env.FAKE_ACP_LOAD_SESSION === "1";
const permission = process.env.FAKE_ACP_PERMISSION === "1";

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function textOf(prompt) {
  return (prompt || [])
    .map((block) => block?.type === "text" ? block.text || "" : "")
    .filter(Boolean)
    .join("\n");
}

async function handle(frame) {
  if ("result" in frame || "error" in frame) return;
  const { id, method, params } = frame;
  if (method === "initialize") {
    result(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession,
        promptCapabilities: { embeddedContext: true },
      },
      agentInfo: { name: "fake-acp-agent", version: "0.1.0" },
      authMethods: [],
    });
    return;
  }
  if (method === "session/new") {
    const sessionId = `fake-${randomUUID()}`;
    sessions.add(sessionId);
    result(id, { sessionId });
    return;
  }
  if (method === "session/load") {
    if (!loadSession) {
      error(id, -32601, "load not supported");
      return;
    }
    sessions.add(params.sessionId);
    notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: "loaded",
      },
    });
    result(id, null);
    return;
  }
  if (method === "session/prompt") {
    if (permission) {
      send({
        jsonrpc: "2.0",
        id: `perm-${id}`,
        method: "session/request_permission",
        params: {
          sessionId: params.sessionId,
          toolCall: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            title: "fake permission",
            status: "pending",
          },
          options: [
            { optionId: "reject", kind: "reject_once", name: "Reject" },
            { optionId: "allow", kind: "allow_once", name: "Allow" },
          ],
        },
      });
    }
    notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "fake tool",
        status: "in_progress",
      },
    });
    notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `echo: ${textOf(params.prompt)}` },
      },
    });
    result(id, { stopReason: "end_turn" });
    return;
  }
  if (method === "session/cancel") {
    return;
  }
  if (String(method).startsWith("session/request_permission")) {
    result(id, {});
    return;
  }
  error(id, -32601, `unknown method ${method}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  handle(JSON.parse(line)).catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
  });
});
