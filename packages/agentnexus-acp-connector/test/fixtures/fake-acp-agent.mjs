import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";

const sessions = new Map();
const loadSession = process.env.FAKE_ACP_LOAD_SESSION === "1";
const permission = process.env.FAKE_ACP_PERMISSION === "1";
const returnFile = process.env.FAKE_ACP_RETURN_FILE === "1";
const returnFileLink = process.env.FAKE_ACP_RETURN_FILE_LINK === "1";
const returnFileLinkWithLine = process.env.FAKE_ACP_RETURN_FILE_LINK_WITH_LINE === "1";
const returnMissingFileLink = process.env.FAKE_ACP_RETURN_MISSING_FILE_LINK === "1";
const returnFileReferences = process.env.FAKE_ACP_RETURN_FILE_REFERENCES === "1";
const returnOptions = process.env.FAKE_ACP_OPTIONS === "1";
const promptErrorKind = process.env.FAKE_ACP_PROMPT_ERROR_KIND || "";
const promptErrorMessage = process.env.FAKE_ACP_PROMPT_ERROR_MESSAGE || "";
const promptDelayMs = Number(process.env.FAKE_ACP_PROMPT_DELAY_MS || "0");
const promptDelayIfIncludes = process.env.FAKE_ACP_PROMPT_DELAY_IF_INCLUDES || "";

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(prompt) {
  return (prompt || [])
    .map((block) => {
      if (block?.type === "text") return block.text || "";
      if (block?.type === "image") {
        return `[image:${block.mimeType || "unknown"}:${String(block.data || "").length}]`;
      }
      if (block?.type === "resource") {
        const resource = block.resource || {};
        return `[resource:${resource.uri || "unknown"}]\n${resource.text || resource.blob || ""}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function sessionOptions() {
  if (!returnOptions) return {};
  return {
    modes: {
      currentModeId: "ask",
      availableModes: [
        { id: "ask", name: "Ask", description: "Ask before changes" },
        { id: "code", name: "Code", description: "Use coding tools" },
      ],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        currentValueId: "fake-small",
        values: [
          { id: "fake-small", name: "Fake Small" },
          { id: "fake-large", name: "Fake Large" },
        ],
      },
    ],
  };
}

async function handle(frame) {
  if ("result" in frame || "error" in frame) return;
  const { id, method, params } = frame;
  if (method === "initialize") {
    result(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession,
        promptCapabilities: { image: true, embeddedContext: true },
      },
      agentInfo: { name: "fake-acp-agent", version: "0.1.0" },
      authMethods: [],
    });
    return;
  }
  if (method === "session/new") {
    const sessionId = `fake-${randomUUID()}`;
    sessions.set(sessionId, params.cwd || process.cwd());
    result(id, { sessionId, ...sessionOptions() });
    return;
  }
  if (method === "session/load") {
    if (!loadSession) {
      error(id, -32601, "load not supported");
      return;
    }
    sessions.set(params.sessionId, params.cwd || process.cwd());
    notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: "loaded",
      },
    });
    result(id, sessionOptions());
    return;
  }
  if (method === "session/prompt") {
    const promptText = textOf(params.prompt);
    if (promptDelayMs > 0 && (!promptDelayIfIncludes || promptText.includes(promptDelayIfIncludes))) {
      await sleep(promptDelayMs);
    }
    if (promptErrorKind) {
      error(
        id,
        -32603,
        promptErrorMessage || "Internal error: fake prompt error",
        { errorKind: promptErrorKind },
      );
      return;
    }
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
        content: { type: "text", text: `echo: ${promptText}` },
      },
    });
    if (returnFile) {
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "resource",
            resource: {
              uri: "file:///tmp/acp-result.md",
              mimeType: "text/markdown",
              text: "# ACP Result\n\nGenerated by fake ACP agent.\n",
            },
          },
        },
      });
    }
    if (returnFileLink) {
      const cwd = sessions.get(params.sessionId) || process.cwd();
      const filePath = path.join(cwd, "fake-linked-result.md");
      await writeFile(filePath, "# Linked Result\n\nGenerated through a markdown file link.\n", "utf8");
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\nCreated linked file: [fake-linked-result.md](${filePath})`,
          },
        },
      });
    }
    if (returnFileLinkWithLine) {
      const cwd = sessions.get(params.sessionId) || process.cwd();
      const filePath = path.join(cwd, "fake-line-linked-result.md");
      await writeFile(filePath, "# Line Linked Result\n\nGenerated through a markdown file link with a line suffix.\n", "utf8");
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\nCreated linked file: [fake-line-linked-result.md](${filePath}:12)`,
          },
        },
      });
    }
    if (returnMissingFileLink) {
      const cwd = sessions.get(params.sessionId) || process.cwd();
      const filePath = path.join(cwd, "missing-linked-result.md");
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\nMissing linked file: [missing-linked-result.md](${filePath})`,
          },
        },
      });
    }
    if (returnFileReferences) {
      const cwd = sessions.get(params.sessionId) || process.cwd();
      const absolutePath = path.join(cwd, "plain-absolute-result.csv");
      const backtickPath = path.join(cwd, "backtick result.md");
      const relativePath = path.join(cwd, "relative-result.json");
      const structuredPath = path.join(cwd, "structured-path-result.txt");
      await writeFile(absolutePath, "kind,value\nabsolute,1\n", "utf8");
      await writeFile(backtickPath, "# Backtick Result\n\nGenerated through a backtick path.\n", "utf8");
      await writeFile(relativePath, "{\"kind\":\"relative\"}\n", "utf8");
      await writeFile(structuredPath, "structured path file\n", "utf8");
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: [
              `Saved file: ${absolutePath}`,
              `Created \`${backtickPath}\``,
              "Relative output: [relative-result.json](relative-result.json)",
            ].join("\n"),
          },
        },
      });
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "file",
            path: structuredPath,
            mimeType: "text/plain",
          },
        },
      });
    }
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
