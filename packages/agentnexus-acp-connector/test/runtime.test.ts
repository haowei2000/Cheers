import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectorRuntime } from "../src/runtime.js";
import { SessionStateStore } from "../src/state.js";
import { MockBridge } from "./mock-bridge.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("ConnectorRuntime", () => {
  let tmp: string;
  let bridge: MockBridge;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "agentnexus-acp-"));
    bridge = new MockBridge();
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
    await rm(tmp, { recursive: true, force: true });
  });

  it("maps AgentNexus message frames to ACP prompt and streams deltas back", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            permissionMode: "reject",
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-1",
      channel_id: "C1",
      seq: 1,
      placeholder_msg_id: "ph-1",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "hello from nexus", sender_name: "Alice" },
    });

    await waitFor(() => bridge.receivedDeltas.length > 0 && bridge.receivedDones.length === 1);
    expect(bridge.receivedDeltas.map((d) => d.delta).join("")).toContain("echo: hello from nexus");
    expect(bridge.receivedDones[0]).toMatchObject({ type: "done", msg_id: "ph-1" });
    expect(bridge.receivedTraces.some((t) => t.phase === "prompt_finished")).toBe(true);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.sessions["codex-main"]["agentnexus:channel:C1"].acpSessionId).toMatch(/^fake-/);
    await runtime.stop();
  });

  it("applies remote connector control updates from AgentNexus", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            permissionMode: "reject",
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushConfigUpdate({
      revision: 7,
      settings: {
        permissionMode: "allow",
        promptTimeoutMs: 60_000,
        requestTimeoutMs: 30_000,
      },
    });

    await waitFor(() => bridge.receivedConfigStatuses.length === 1);
    expect(bridge.receivedConfigStatuses[0]).toMatchObject({
      type: "config_status",
      revision: 7,
      ok: true,
      applied: ["permissionMode", "requestTimeoutMs", "promptTimeoutMs"],
      rejected: [],
    });
    await runtime.stop();
  });

  it("restarts codex-acp when remote cwd or model changes", async () => {
    const statePath = path.join(tmp, "state.json");
    const workspace = path.join(tmp, "next-workspace");
    await mkdir(workspace);
    const codexAcp = path.join(tmp, "codex-acp");
    await writeFile(
      codexAcp,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAgent)} "$@"\n`,
      "utf8",
    );
    await chmod(codexAcp, 0o755);
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: codexAcp,
            args: [],
            cwd: tmp,
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushConfigUpdate({
      revision: 8,
      settings: {
        cwd: workspace,
        model: "gpt-5.5",
      },
    });

    await waitFor(() => bridge.receivedConfigStatuses.length === 1);
    expect(bridge.receivedConfigStatuses[0]).toMatchObject({
      type: "config_status",
      revision: 8,
      ok: true,
      applied: ["cwd", "model"],
      rejected: [],
    });
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);
    await runtime.stop();
  });

  it("reports ACP-discovered session options over connector control", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_OPTIONS: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-options",
      channel_id: "C1",
      seq: 9,
      placeholder_msg_id: "ph-options",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "discover options" },
    });

    await waitFor(() => bridge.receivedConfigOptions.some((frame) => {
      const options = frame.options as Record<string, unknown> | undefined;
      return Array.isArray(options?.configOptions);
    }));
    const frame = bridge.receivedConfigOptions.find((item) => {
      const options = item.options as Record<string, unknown> | undefined;
      return Array.isArray(options?.configOptions);
    })!;
    const options = frame.options as Record<string, unknown>;
    expect(options.source).toBe("acp");
    expect(options.sessionId).toMatch(/^fake-/);
    expect(options.providerSessionKey).toBe("agentnexus:channel:C1");
    expect(options.modes).toMatchObject({
      currentModeId: "ask",
      availableModes: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code" },
      ],
    });
    expect(options.configOptions).toEqual([
      {
        id: "model",
        name: "Model",
        currentValueId: "fake-small",
        values: [
          { id: "fake-small", name: "Fake Small" },
          { id: "fake-large", name: "Fake Large" },
        ],
      },
    ]);
    await runtime.stop();
  });

  it("runs different provider sessions concurrently", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_PROMPT_DELAY_MS: "300", FAKE_ACP_PROMPT_DELAY_IF_INCLUDES: "slow session" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-slow",
      channel_id: "C1",
      seq: 10,
      placeholder_msg_id: "ph-slow",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "slow session first" },
    });
    bridge.pushMessage({
      task_id: "task-fast",
      channel_id: "D1",
      seq: 11,
      placeholder_msg_id: "ph-fast",
      provider_session_key: "agentnexus:dm:user:U1:bot:bot-acp",
      trigger_message: { text: "fast dm second" },
    });

    await waitFor(() => bridge.receivedDones.length >= 1);
    expect(bridge.receivedDones[0]).toMatchObject({ type: "done", msg_id: "ph-fast" });
    await waitFor(() => bridge.receivedDones.length === 2);
    expect(bridge.receivedDones.map((d) => d.msg_id)).toEqual(["ph-fast", "ph-slow"]);
    await runtime.stop();
  });

  it("keeps messages in the same provider session ordered", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_PROMPT_DELAY_MS: "300", FAKE_ACP_PROMPT_DELAY_IF_INCLUDES: "slow session" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-same-slow",
      channel_id: "C1",
      seq: 12,
      placeholder_msg_id: "ph-same-slow",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "slow session first" },
    });
    bridge.pushMessage({
      task_id: "task-same-fast",
      channel_id: "C1",
      seq: 13,
      placeholder_msg_id: "ph-same-fast",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "fast same session second" },
    });

    await waitFor(() => bridge.receivedDones.length === 2);
    expect(bridge.receivedDones.map((d) => d.msg_id)).toEqual(["ph-same-slow", "ph-same-fast"]);
    await runtime.stop();
  });

  it("normalizes ACP auth and quota errors before sending stream errors", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: {
              FAKE_ACP_PROMPT_ERROR_KIND: "rate_limit",
              FAKE_ACP_PROMPT_ERROR_MESSAGE: "Internal error: You've hit your limit · resets 1:30pm (Asia/Shanghai)",
            },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-rate-limit",
      channel_id: "C1",
      seq: 14,
      placeholder_msg_id: "ph-rate-limit",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "hello" },
    });

    await waitFor(() => bridge.receivedErrors.length === 1);
    const visibleError = bridge.receivedDeltas.map((d) => d.delta).join("");
    expect(visibleError).toContain("Claude usage limit reached");
    expect(visibleError).toContain("resets 1:30pm");
    expect(bridge.receivedErrors[0]).toMatchObject({
      type: "error",
      msg_id: "ph-rate-limit",
    });
    expect(String(bridge.receivedErrors[0].message)).toContain("Claude usage limit reached");
    expect(String(bridge.receivedErrors[0].message)).toContain("resets 1:30pm");
    expect(bridge.receivedTraces.some((t) => t.phase === "prompt_failed" && t.status === "error")).toBe(true);
    await runtime.stop();
  });

  it("loads a persisted ACP session when the agent supports session/load", async () => {
    const statePath = path.join(tmp, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        sessions: {
          "codex-main": {
            "agentnexus:channel:C1": {
              acpSessionId: "persisted-session",
              updatedAt: new Date().toISOString(),
            },
          },
        },
      }),
      "utf8",
    );
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_LOAD_SESSION: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    bridge.pushMessage({
      task_id: "task-2",
      channel_id: "C1",
      seq: 2,
      placeholder_msg_id: "ph-2",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "reuse me" },
    });

    await waitFor(() => bridge.receivedDones.length === 1);
    expect(bridge.receivedTraces.some((t) => t.run_id === "persisted-session")).toBe(true);
    await runtime.stop();
  });

  it("uploads ACP resource content and attaches returned file ids to stream done", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_RETURN_FILE: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-file",
      channel_id: "C1",
      seq: 3,
      placeholder_msg_id: "ph-file",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "return a report file" },
    });

    await waitFor(() => bridge.receivedUploads.length === 1 && bridge.receivedDones.length === 1);
    expect(bridge.receivedUploads[0]).toMatchObject({
      type: "file_upload",
      channel_id: "C1",
      filename: "acp-result.md",
      content_type: "text/markdown",
    });
    expect(Buffer.from(String(bridge.receivedUploads[0].data_b64), "base64").toString("utf8"))
      .toContain("Generated by fake ACP agent");
    expect(bridge.receivedDones[0]).toMatchObject({
      type: "done",
      msg_id: "ph-file",
      file_ids: ["file-1"],
    });
    expect(bridge.receivedTraces.some((t) => t.phase === "file_uploaded")).toBe(true);
    await runtime.stop();
  });

  it("uploads newly created local files linked in ACP text output", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_RETURN_FILE_LINK: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-linked-file",
      channel_id: "C1",
      seq: 4,
      placeholder_msg_id: "ph-linked-file",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "create and link a report file" },
    });

    await waitFor(() => bridge.receivedUploads.length === 1 && bridge.receivedDones.length === 1);
    expect(bridge.receivedUploads[0]).toMatchObject({
      type: "file_upload",
      channel_id: "C1",
      filename: "fake-linked-result.md",
      content_type: "text/markdown",
    });
    expect(Buffer.from(String(bridge.receivedUploads[0].data_b64), "base64").toString("utf8"))
      .toContain("Generated through a markdown file link");
    expect(bridge.receivedDones[0]).toMatchObject({
      type: "done",
      msg_id: "ph-linked-file",
      file_ids: ["file-1"],
    });
    await runtime.stop();
  });

  it("recognizes local files from absolute, relative, backtick, and structured ACP outputs", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_RETURN_FILE_REFERENCES: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-file-references",
      channel_id: "C1",
      seq: 5,
      placeholder_msg_id: "ph-file-references",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "create files in several output formats" },
    });

    await waitFor(() => bridge.receivedUploads.length === 4 && bridge.receivedDones.length === 1);
    const uploads = new Map(bridge.receivedUploads.map((item) => [String(item.filename), item]));
    expect([...uploads.keys()].sort()).toEqual([
      "backtick result.md",
      "plain-absolute-result.csv",
      "relative-result.json",
      "structured-path-result.txt",
    ]);
    expect(Buffer.from(String(uploads.get("plain-absolute-result.csv")?.data_b64), "base64").toString("utf8"))
      .toContain("absolute,1");
    expect(Buffer.from(String(uploads.get("backtick result.md")?.data_b64), "base64").toString("utf8"))
      .toContain("Generated through a backtick path");
    expect(Buffer.from(String(uploads.get("relative-result.json")?.data_b64), "base64").toString("utf8"))
      .toContain("\"relative\"");
    expect(Buffer.from(String(uploads.get("structured-path-result.txt")?.data_b64), "base64").toString("utf8"))
      .toContain("structured path file");
    expect(bridge.receivedDones[0]).toMatchObject({
      type: "done",
      msg_id: "ph-file-references",
      file_ids: ["file-1", "file-2", "file-3", "file-4"],
    });
    await runtime.stop();
  });

  it("uploads linked local files when ACP includes a line suffix", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_RETURN_FILE_LINK_WITH_LINE: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-linked-file-line",
      channel_id: "C1",
      seq: 6,
      placeholder_msg_id: "ph-linked-file-line",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "create and link a report file with line suffix" },
    });

    await waitFor(() => bridge.receivedUploads.length === 1 && bridge.receivedDones.length === 1);
    expect(bridge.receivedUploads[0]).toMatchObject({
      type: "file_upload",
      channel_id: "C1",
      filename: "fake-line-linked-result.md",
      content_type: "text/markdown",
    });
    expect(Buffer.from(String(bridge.receivedUploads[0].data_b64), "base64").toString("utf8"))
      .toContain("line suffix");
    expect(bridge.receivedDones[0]).toMatchObject({
      type: "done",
      msg_id: "ph-linked-file-line",
      file_ids: ["file-1"],
    });
    await runtime.stop();
  });

  it("ignores missing local file links instead of failing the ACP message", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_RETURN_MISSING_FILE_LINK: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-missing-linked-file",
      channel_id: "C1",
      seq: 7,
      placeholder_msg_id: "ph-missing-linked-file",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "mention a missing linked file" },
    });

    await waitFor(() => bridge.receivedDones.length === 1);
    expect(bridge.receivedUploads).toHaveLength(0);
    expect(bridge.receivedErrors).toHaveLength(0);
    expect(bridge.receivedDones[0]).toMatchObject({
      type: "done",
      msg_id: "ph-missing-linked-file",
    });
    await runtime.stop();
  });

  it("retries ACP file uploads after a transient data websocket disconnect", async () => {
    const statePath = path.join(tmp, "state.json");
    bridge.closeNextUploadWithoutAck();
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_RETURN_FILE: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-file-retry",
      channel_id: "C1",
      seq: 8,
      placeholder_msg_id: "ph-file-retry",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "return a report file after reconnect" },
    });

    await waitFor(() => bridge.receivedUploads.length === 1 && bridge.receivedDones.length === 1, 5000);
    expect(bridge.receivedUploads[0]).toMatchObject({
      type: "file_upload",
      channel_id: "C1",
      filename: "acp-result.md",
    });
    expect(bridge.receivedDones[0]).toMatchObject({
      type: "done",
      msg_id: "ph-file-retry",
      file_ids: ["file-1"],
    });
    expect(bridge.receivedTraces.some((t) => t.phase === "file_upload_retry")).toBe(true);
    await runtime.stop();
  });

  it("hydrates AgentNexus text and image attachments as ACP resource/image content blocks", async () => {
    const statePath = path.join(tmp, "state.json");
    bridge.setTextFile("doc-1", {
      filename: "spec.md",
      contentType: "text/markdown",
      content: "# SPEC\n\nDOC_BODY_UNIQUE_42",
      summary: "spec summary",
    });
    bridge.setBinaryFile("img-1", {
      filename: "diagram.png",
      contentType: "image/png",
      data: Buffer.from("fake-png-bytes"),
    });
    const runtime = new ConnectorRuntime(
      {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-attachments",
      channel_id: "C1",
      seq: 4,
      placeholder_msg_id: "ph-attachments",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "please inspect attachments" },
      attachments: [
        {
          file_id: "doc-1",
          filename: "spec.md",
          content_type: "text/markdown",
          size_bytes: 27,
          summary: "spec summary",
        },
        {
          file_id: "img-1",
          filename: "diagram.png",
          content_type: "image/png",
          size_bytes: 14,
        },
      ],
    });

    await waitFor(() => bridge.receivedDones.length === 1);
    const streamed = bridge.receivedDeltas.map((d) => d.delta).join("");
    expect(streamed).toContain("[resource:agentnexus://file/doc-1/spec.md]");
    expect(streamed).toContain("DOC_BODY_UNIQUE_42");
    expect(streamed).toContain("[image:image/png:");
    await runtime.stop();
  });
});
