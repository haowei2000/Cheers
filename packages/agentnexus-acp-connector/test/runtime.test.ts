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
        "opencode-main": {
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
    expect(bridge.receivedDeltas.map((d) => d.delta).join("")).toContain("hello from nexus");
    expect(bridge.receivedDones[0]).toMatchObject({ type: "done", msg_id: "ph-1" });
    expect(bridge.receivedTraces.some((t) => t.phase === "prompt_finished")).toBe(true);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.sessions["opencode-main"]["agentnexus:channel:C1"].acpSessionId).toMatch(/^fake-/);
    await runtime.stop();
  });

  it("applies remote connector control updates from AgentNexus", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
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

  it("restarts opencode when remote cwd or model changes", async () => {
    const statePath = path.join(tmp, "state.json");
    const workspace = path.join(tmp, "next-workspace");
    await mkdir(workspace);
    const opencodeBin = path.join(tmp, "opencode");
    await writeFile(
      opencodeBin,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAgent)} "$@"\n`,
      "utf8",
    );
    await chmod(opencodeBin, 0o755);
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: opencodeBin,
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
        "opencode-main": {
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
    expect(options.configOptions).toMatchObject([
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: "fake-small",
        options: [
          { value: "fake-small", name: "Fake Small" },
          { value: "fake-large", name: "Fake Large" },
        ],
      },
    ]);
    await runtime.stop();
  });

  it("applies ACP session config option values pushed from AgentNexus", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
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

    bridge.pushConfigUpdate({
      revision: 9,
      settings: {
        configOptions: { model: "fake-large" },
      },
    });

    await waitFor(() => bridge.receivedConfigStatuses.length === 1);
    expect(bridge.receivedConfigStatuses[0]).toMatchObject({
      type: "config_status",
      revision: 9,
      ok: true,
      applied: ["configOptions"],
      rejected: [],
    });

    bridge.pushMessage({
      task_id: "task-set-options",
      channel_id: "C1",
      seq: 10,
      placeholder_msg_id: "ph-set-options",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "use configured model" },
    });

    await waitFor(() => bridge.receivedDones.length === 1);
    expect(bridge.receivedDeltas.map((d) => d.delta).join("")).toContain("config: model=fake-large");
    expect(bridge.receivedConfigOptions.some((frame) => {
      const options = frame.options as Record<string, unknown> | undefined;
      const configOptions = options?.configOptions;
      return Array.isArray(configOptions) && configOptions.some((option) => (
        typeof option === "object" &&
        option !== null &&
        (option as Record<string, unknown>).id === "model" &&
        (option as Record<string, unknown>).currentValue === "fake-large"
      ));
    })).toBe(true);
    await runtime.stop();
  });

  it("applies ACP session config options requested over connector control", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
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
      task_id: "task-set-option",
      channel_id: "C1",
      seq: 10,
      placeholder_msg_id: "ph-set-option",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "discover options before setting" },
    });

    await waitFor(() => bridge.receivedConfigOptions.some((frame) => {
      const options = frame.options as Record<string, unknown> | undefined;
      return Array.isArray(options?.configOptions);
    }));
    const optionsFrame = bridge.receivedConfigOptions.find((item) => {
      const options = item.options as Record<string, unknown> | undefined;
      return Array.isArray(options?.configOptions);
    })!;
    const options = optionsFrame.options as Record<string, unknown>;
    const sessionId = String(options.sessionId);

    bridge.pushConfigOptionSet({
      request_id: "set-model-1",
      session_id: sessionId,
      provider_session_key: "agentnexus:channel:C1",
      config_id: "model",
      value: "fake-large",
    });

    await waitFor(() => bridge.receivedConfigOptionStatuses.length === 1);
    expect(bridge.receivedConfigOptionStatuses[0]).toMatchObject({
      type: "config_option_status",
      request_id: "set-model-1",
      ok: true,
      session_id: sessionId,
      provider_session_key: "agentnexus:channel:C1",
      config_id: "model",
      value: "fake-large",
    });
    const statusOptions = bridge.receivedConfigOptionStatuses[0].options as Record<string, unknown>;
    expect(statusOptions.configOptions).toMatchObject([
      {
        id: "model",
        name: "Model",
        currentValue: "fake-large",
        currentValueId: "fake-large",
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
        "opencode-main": {
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
        "opencode-main": {
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
        "opencode-main": {
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

  it("times out a stalled ACP prompt and reports the stream error", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_HANG_PROMPT: "1" },
            requestTimeoutMs: 1000,
            promptTimeoutMs: 50,
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-stalled",
      channel_id: "C1",
      seq: 15,
      placeholder_msg_id: "ph-stalled",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "stall this prompt" },
    });

    await waitFor(() => bridge.receivedErrors.length === 1);
    expect(bridge.receivedErrors[0]).toMatchObject({
      type: "error",
      msg_id: "ph-stalled",
    });
    expect(String(bridge.receivedErrors[0].message)).toContain("ACP request timed out after 50ms: session/prompt");
    expect(bridge.receivedTraces.some((t) => t.phase === "prompt_timeout" && t.status === "failed")).toBe(true);
    await runtime.stop();
  });

  it("loads a persisted ACP session when the agent supports session/load", async () => {
    const statePath = path.join(tmp, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        sessions: {
          "opencode-main": {
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
        "opencode-main": {
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
        "opencode-main": {
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

  it("uploads ACP image content chunks as AgentNexus files", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_RETURN_IMAGE: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-image",
      channel_id: "C1",
      seq: 4,
      placeholder_msg_id: "ph-image",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "return an image" },
    });

    await waitFor(() => bridge.receivedUploads.length === 1 && bridge.receivedDones.length === 1);
    expect(bridge.receivedUploads[0]).toMatchObject({
      type: "file_upload",
      channel_id: "C1",
      filename: "acp-output.png",
      content_type: "image/png",
    });
    expect(Buffer.from(String(bridge.receivedUploads[0].data_b64), "base64").toString("utf8"))
      .toBe("fake-png-output");
    expect(bridge.receivedDones[0]).toMatchObject({
      type: "done",
      msg_id: "ph-image",
      file_ids: ["file-1"],
    });
    await runtime.stop();
  });

  it("rotates the ACP session and retries once when OpenAI image item ids were not persisted", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
          botToken: "agb_test",
          controlUrl: bridge.controlUrl,
          dataUrl: bridge.dataUrl,
          advanced: { reconnectBaseMs: 20, reconnectMaxMs: 100, heartbeatIntervalMs: 60_000, sendAckTimeoutMs: 1000 },
          agent: {
            transport: "stdio",
            command: process.execPath,
            args: [fakeAgent],
            cwd: tmp,
            env: { FAKE_ACP_FAIL_FIRST_PROMPT_NONPERSISTED_ITEM: "1" },
          },
        },
      },
      new SessionStateStore(statePath),
      console,
    );
    await runtime.start();
    await waitFor(() => bridge.connectionsFor("control") === 1 && bridge.connectionsFor("data") === 1);

    bridge.pushMessage({
      task_id: "task-nonpersisted-item",
      channel_id: "C1",
      seq: 5,
      placeholder_msg_id: "ph-nonpersisted-item",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "generate an image and return it" },
    });

    await waitFor(() => bridge.receivedDones.length === 1);
    expect(bridge.receivedErrors).toHaveLength(0);
    expect(bridge.receivedDeltas.map((d) => d.delta).join("")).toContain("echo:");
    expect(bridge.receivedTraces.some((t) => t.phase === "provider_session_rotated")).toBe(true);
    const promptStarts = bridge.receivedTraces.filter((t) => t.phase === "prompt_started");
    expect(promptStarts).toHaveLength(2);
    expect(promptStarts[0].run_id).not.toBe(promptStarts[1].run_id);
    await runtime.stop();
  });

  it("uploads newly created local files linked in ACP text output", async () => {
    const statePath = path.join(tmp, "state.json");
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
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
        "opencode-main": {
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
        "opencode-main": {
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
        "opencode-main": {
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
        "opencode-main": {
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
        "opencode-main": {
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

  it("hydrates AgentNexus inline image attachments without a binary fetch", async () => {
    const statePath = path.join(tmp, "state.json");
    const imageB64 = Buffer.from("inline-png-bytes").toString("base64");
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
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
      task_id: "task-inline-image",
      channel_id: "C1",
      seq: 5,
      placeholder_msg_id: "ph-inline-image",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "please inspect inline image" },
      attachments: [
        {
          file_id: "inline-img-1",
          filename: "inline.png",
          content_type: "image/png",
          size_bytes: 16,
          is_image: "true",
          image_b64: imageB64,
        },
      ],
    });

    await waitFor(() => bridge.receivedDones.length === 1);
    const streamed = bridge.receivedDeltas.map((d) => d.delta).join("");
    expect(streamed).toContain(`[image:image/png:${imageB64.length}]`);
    await runtime.stop();
  });

  it("downloads unsupported document attachments to local files for ACP agents", async () => {
    const statePath = path.join(tmp, "state.json");
    bridge.setBinaryFile("doc-legacy", {
      filename: "legacy.doc",
      contentType: "application/msword",
      data: Buffer.from("legacy document bytes"),
    });
    const runtime = new ConnectorRuntime(
      {
        "opencode-main": {
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
      task_id: "task-binary-attachment",
      channel_id: "C1",
      seq: 6,
      placeholder_msg_id: "ph-binary-attachment",
      provider_session_key: "agentnexus:channel:C1",
      trigger_message: { text: "please inspect the legacy document" },
      attachments: [
        {
          file_id: "doc-legacy",
          filename: "legacy.doc",
          content_type: "application/msword",
          size_bytes: 21,
        },
      ],
    });

    await waitFor(() => bridge.receivedDones.length === 1);
    const savedPath = path.join(tmp, ".agentnexus", "attachments", "task-binary-attachment", "doc-legacy", "legacy.doc");
    await expect(readFile(savedPath, "utf8")).resolves.toBe("legacy document bytes");
    const streamed = bridge.receivedDeltas.map((d) => d.delta).join("");
    expect(streamed).toContain("Attachment file: legacy.doc");
    expect(streamed).toContain(savedPath);
    expect(streamed).toContain("[resource:file://");
    expect(bridge.receivedUploads).toHaveLength(0);
    await runtime.stop();
  });
});
