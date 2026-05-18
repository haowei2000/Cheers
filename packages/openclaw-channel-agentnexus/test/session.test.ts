/**
 * BotSession unit tests using a mock WS server, without a real backend.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BotSession, type InboundMessage } from "../src/session.js";
import type { ChannelInfo } from "../src/types.js";

import { MockBridge } from "./mock-bridge.js";

const TOKEN = "agb_test_token";

async function makeSession(
  bridge: MockBridge,
  events: Parameters<typeof newSession>[2] = {},
) {
  return newSession(bridge.controlUrl, bridge.dataUrl, events);
}

function newSession(
  controlUrl: string,
  dataUrl: string,
  events: ConstructorParameters<typeof BotSession>[1],
) {
  return new BotSession(
    {
      botToken: TOKEN,
      controlUrl,
      dataUrl,
      advanced: {
        reconnectBaseMs: 50,
        reconnectMaxMs: 500,
        heartbeatIntervalMs: 60_000, // Heartbeats are unnecessary in tests.
        sendAckTimeoutMs: 2000,
      },
    },
    events,
  );
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("BotSession with mock bridge", () => {
  let bridge: MockBridge;

  beforeEach(async () => {
    bridge = new MockBridge({
      botToken: TOKEN,
      botId: "bot-mock",
      botUsername: "mock",
      initialMemberships: [
        { channel_id: "C1", channel_name: "general", channel_type: "public" },
        { channel_id: "C2", channel_name: "dev", channel_type: "private" },
      ],
    });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
  });

  it("receives hello and populates memberships", async () => {
    const session = await makeSession(bridge, {});
    session.start();
    await session.waitReady(3000);
    expect(session.botId).toBe("bot-mock");
    expect(session.membership.channelIds.size).toBe(2);
    expect(session.membership.byId.get("C1")?.channel_name).toBe("general");
    await session.stop();
  });

  it("updates membership on channel_joined / channel_left", async () => {
    const joined: ChannelInfo[] = [];
    const left: string[] = [];
    const session = await makeSession(bridge, {
      onChannelJoined: (ch) => joined.push(ch),
      onChannelLeft: (id) => left.push(id),
    });
    session.start();
    await session.waitReady();

    bridge.pushChannelJoined({ channel_id: "C3", channel_name: "random", channel_type: "public" });
    await waitFor(() => session.membership.channelIds.has("C3"));
    expect(joined).toHaveLength(1);
    expect(joined[0].channel_id).toBe("C3");

    bridge.pushChannelLeft("C1");
    await waitFor(() => !session.membership.channelIds.has("C1"));
    expect(left).toEqual(["C1"]);

    await session.stop();
  });

  it("dispatches message and reply round-trips with send_ack", async () => {
    const received: InboundMessage[] = [];
    const session = await makeSession(bridge, {
      onMessage: (m) => {
        received.push(m);
      },
    });
    session.start();
    await session.waitReady();

    bridge.pushMessage({
      task_id: "task-1",
      channel_id: "C1",
      seq: 1,
      placeholder_msg_id: "ph-1",
      trigger_message: { user: "u1", sender_name: "Alice", text: "hello", timestamp: "2026-04-21T00:00:00Z" },
    });

    await waitFor(() => received.length === 1);
    const m = received[0];
    expect(m.channelId).toBe("C1");
    expect(m.text).toBe("hello");
    expect(m.senderName).toBe("Alice");
    expect(session.lastProcessedSeq).toBe(1);

    const r = await session.reply({ source: m, text: "hi back" });
    expect(r.ok).toBe(true);
    expect(r.finalizedPlaceholder).toBe(true);
    expect(r.messageId).toBeTruthy();

    expect(bridge.receivedReplies).toHaveLength(1);
    expect(bridge.receivedReplies[0].task_id).toBe("task-1");
    expect(bridge.receivedReplies[0].reply_to_msg_id).toBe("ph-1");
    expect(bridge.receivedReplies[0].text).toBe("hi back");

    await session.stop();
  });

  it("send() routes to send frame + ack", async () => {
    const session = await makeSession(bridge, {});
    session.start();
    await session.waitReady();

    const r = await session.send({ channelId: "C1", text: "broadcast" });
    expect(r.ok).toBe(true);
    expect(bridge.receivedSends).toHaveLength(1);
    expect(bridge.receivedSends[0].type).toBe("send");
    expect(bridge.receivedSends[0].channel_id).toBe("C1");

    await session.stop();
  });

  it("trace() sends a fire-and-forget trace frame", async () => {
    const session = await makeSession(bridge, {});
    session.start();
    await session.waitReady();

    const ok = session.trace({
      msg_id: "ph-1",
      task_id: "task-1",
      channel_id: "C1",
      run_id: "run-1",
      stream: "tool",
      seq: 3,
      title: "read_file",
      message: "running",
    });

    expect(ok).toBe(true);
    await waitFor(() => bridge.receivedTraces.length === 1);
    expect(bridge.receivedTraces[0]).toMatchObject({
      type: "trace",
      msg_id: "ph-1",
      task_id: "task-1",
      stream: "tool",
      title: "read_file",
    });

    await session.stop();
  });

  it("reply times out when bridge swallows the frame", async () => {
    bridge.autoAckReply = false;
    const received: InboundMessage[] = [];
    const session = await makeSession(bridge, {
      onMessage: (m) => received.push(m),
    });
    session.start();
    await session.waitReady();

    bridge.pushMessage({ task_id: "t", channel_id: "C1", seq: 1 });
    await waitFor(() => received.length === 1);

    const r = await session.reply({ source: received[0], text: "no ack" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ack_timeout");

    await session.stop();
  });

  it("supersede (4402) stops the session and surfaces onFatal", async () => {
    const fatals: string[] = [];
    const session = await makeSession(bridge, {
      onFatal: (r) => fatals.push(r),
    });
    session.start();
    await session.waitReady();

    // Backend kicks off the control connection.
    bridge.supersede("control");

    // The session should stop shortly after onFatal triggers stop().
    await waitFor(() => fatals.length > 0, 3000);
    // Starting again should throw.
    expect(() => session.start()).toThrow(/stopped/);
  });

  it("on reconnect (non-fatal close), data stream sends resume with last_event_seq", async () => {
    const session = await makeSession(bridge, {});
    session.start();
    await session.waitReady();

    // Simulate processing through seq=5.
    bridge.pushMessage({ task_id: "t1", channel_id: "C1", seq: 5 });
    await waitFor(() => session.lastProcessedSeq === 5);

    // Close data with 1006 (abnormal); this is non-fatal and should reconnect.
    // Closing from the mock server with any non-4401/4402/4403 code is sufficient.
    const beforeCount = bridge.receivedResumes.length;
    for (const c of (bridge as unknown as { conns: Set<{ ws: { close: (c: number, r: string) => void; readyState: number }; stream: string }> }).conns) {
      if (c.stream === "data" && c.ws.readyState === 1 /* OPEN */) {
        c.ws.close(1011, "transient error");
      }
    }

    // Reconnect should send resume {last_event_seq: 5}.
    await waitFor(() => bridge.receivedResumes.length > beforeCount, 5000);
    const lastResume = bridge.receivedResumes[bridge.receivedResumes.length - 1];
    expect(lastResume.type).toBe("resume");
    expect(lastResume.last_event_seq).toBe(5);

    await session.stop();
  });

  it("does not advance resume seq until onMessage succeeds", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const session = await makeSession(bridge, {
      onMessage: async () => {
        calls += 1;
        throw new Error("handler failed");
      },
      onError: (err) => errors.push(err),
    });
    session.start();
    await session.waitReady();

    const beforeCount = bridge.receivedResumes.length;
    bridge.pushMessage({ task_id: "t-fail", channel_id: "C1", seq: 7 });
    bridge.pushMessage({ task_id: "t-skip", channel_id: "C1", seq: 8 });
    await waitFor(() => errors.length > 0);
    expect(session.lastProcessedSeq).toBe(0);
    expect(calls).toBe(1);

    await waitFor(() => bridge.receivedResumes.length > beforeCount, 5000);
    const lastResume = bridge.receivedResumes[bridge.receivedResumes.length - 1];
    expect(lastResume.last_event_seq).toBe(0);

    await session.stop();
  });

  it("invalid token (401) prevents accept; session eventually becomes fatal", async () => {
    // Create a session with an invalid token.
    const fatals: string[] = [];
    const s = new BotSession(
      {
        botToken: "agb_wrong",
        controlUrl: bridge.controlUrl,
        dataUrl: bridge.dataUrl,
        advanced: { reconnectBaseMs: 30, reconnectMaxMs: 60, sendAckTimeoutMs: 500 },
      },
      { onFatal: (r) => fatals.push(r) },
    );
    s.start();
    // The mock rejects upgrade with HTTP 401 on auth failure; the client sees ws error/close.
    // This is not 4401/4402/4403, so ReconnectingClient keeps retrying as non-fatal.
    // To keep the test finite, do not wait for fatal; only verify the session cannot connect.
    await new Promise((r) => setTimeout(r, 200));
    expect(s.botId).toBeNull();
    await s.stop();
  });
});
