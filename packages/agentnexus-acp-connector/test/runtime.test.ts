import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
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
