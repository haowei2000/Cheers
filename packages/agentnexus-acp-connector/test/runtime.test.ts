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
});
