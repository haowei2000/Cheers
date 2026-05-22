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
const returnTgzFileReference = process.env.FAKE_ACP_RETURN_TGZ_FILE_REFERENCE === "1";
const returnImage = process.env.FAKE_ACP_RETURN_IMAGE === "1";
const returnOptions = process.env.FAKE_ACP_OPTIONS === "1";
const modifyPromptAttachmentPath = process.env.FAKE_ACP_MODIFY_PROMPT_ATTACHMENT_PATH === "1";
const promptErrorKind = process.env.FAKE_ACP_PROMPT_ERROR_KIND || "";
const promptErrorMessage = process.env.FAKE_ACP_PROMPT_ERROR_MESSAGE || "";
const failFirstPromptWithNonPersistedItem = process.env.FAKE_ACP_FAIL_FIRST_PROMPT_NONPERSISTED_ITEM === "1";
const hangPrompt = process.env.FAKE_ACP_HANG_PROMPT === "1";
const promptDelayMs = Number(process.env.FAKE_ACP_PROMPT_DELAY_MS || "0");
const promptDelayIfIncludes = process.env.FAKE_ACP_PROMPT_DELAY_IF_INCLUDES || "";
let nonPersistedItemFailureSent = false;
const pendingClientRequests = new Map();

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

function request(method, params) {
  const id = `client-${randomUUID()}`;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingClientRequests.delete(id);
      reject(new Error(`client request timed out: ${method}`));
    }, 30_000);
    pendingClientRequests.set(id, { resolve, reject, timer });
  });
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
      if (block?.type === "resource_link") {
        return `[resource_link:${block.uri || "unknown"}:${block.name || ""}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function ensureSession(sessionId, cwd) {
  let state = sessions.get(sessionId);
  if (!state || typeof state === "string") {
    state = {
      cwd: typeof state === "string" ? state : cwd || process.cwd(),
      config: { model: "fake-small" },
    };
    sessions.set(sessionId, state);
  }
  if (cwd) state.cwd = cwd;
  return state;
}

function sessionCwd(sessionId) {
  return ensureSession(sessionId).cwd;
}

function sessionOptions(sessionId) {
  if (!returnOptions) return {};
  const state = ensureSession(sessionId);
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
        type: "select",
        category: "model",
        currentValue: state.config.model,
        currentValueId: state.config.model,
        options: [
          { value: "fake-small", name: "Fake Small" },
          { value: "fake-large", name: "Fake Large" },
        ],
        values: [
          { id: "fake-small", name: "Fake Small" },
          { id: "fake-large", name: "Fake Large" },
        ],
      },
    ],
  };
}

async function handle(frame) {
  if ("result" in frame || "error" in frame) {
    const pending = pendingClientRequests.get(frame.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingClientRequests.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message || "client request failed"));
      else pending.resolve(frame.result);
    }
    return;
  }
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
    ensureSession(sessionId, params.cwd || process.cwd());
    result(id, { sessionId, ...sessionOptions(sessionId) });
    return;
  }
  if (method === "session/load") {
    if (!loadSession) {
      error(id, -32601, "load not supported");
      return;
    }
    ensureSession(params.sessionId, params.cwd || process.cwd());
    ensureSession(params.sessionId, params.cwd || process.cwd());
    notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: "loaded",
      },
    });
    result(id, sessionOptions(params.sessionId));
    return;
  }
  if (method === "session/set_config_option") {
    if (!returnOptions) {
      error(id, -32601, "config options not supported");
      return;
    }
    if (!sessions.has(params.sessionId)) {
      error(id, -32000, "unknown session");
      return;
    }
    if (params.configId !== "model") {
      error(id, -32000, "unknown config option");
      return;
    }
    if (params.value !== "fake-small" && params.value !== "fake-large") {
      error(id, -32000, "unknown config option value");
      return;
    }
    const state = ensureSession(params.sessionId);
    state.config.model = params.value;
    result(id, sessionOptions(params.sessionId));
    return;
  }
  if (method === "session/prompt") {
    const state = ensureSession(params.sessionId);
    const promptText = textOf(params.prompt);
    if (hangPrompt) return;
    if (promptDelayMs > 0 && (!promptDelayIfIncludes || promptText.includes(promptDelayIfIncludes))) {
      await sleep(promptDelayMs);
    }
    if (modifyPromptAttachmentPath) {
      const match = /^Saved locally:\s*(.+)$/m.exec(promptText);
      if (match) {
        await writeFile(match[1].trim(), "modified legacy document bytes", "utf8");
      }
    }
    if (failFirstPromptWithNonPersistedItem && !nonPersistedItemFailureSent) {
      nonPersistedItemFailureSent = true;
      error(
        id,
        -32603,
        "unexpected status 404 Not Found: Item with id 'ig_fake_nonpersisted' not found. Items are not persisted when `store` is set to false. Try again with `store` set to true, or remove this item from your input.",
      );
      return;
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
      const permissionResult = await request(
        "session/request_permission",
        {
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
      );
      const outcome = permissionResult?.outcome || {};
      if (outcome.outcome !== "selected" || outcome.optionId !== "allow") {
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "permission denied" },
          },
        });
        result(id, { stopReason: "cancelled" });
        return;
      }
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
        content: {
          type: "text",
          text: returnOptions
            ? `echo: ${promptText}\nconfig: model=${state.config.model}`
            : `echo: ${promptText}`,
        },
      },
    });
    if (returnImage) {
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from("fake-png-output").toString("base64"),
          },
        },
      });
    }
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
      const cwd = sessionCwd(params.sessionId);
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
      const cwd = sessionCwd(params.sessionId);
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
      const cwd = sessionCwd(params.sessionId);
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
      const cwd = sessionCwd(params.sessionId);
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
    if (returnTgzFileReference) {
      const cwd = sessionCwd(params.sessionId);
      const filename = "agentnexus-acp-connector-0.1.9.tgz";
      const filePath = path.join(cwd, filename);
      await writeFile(filePath, Buffer.from("fake npm package tarball"));
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\nPackage file: ${filename}`,
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
