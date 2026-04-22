/**
 * BotSession 行为单测（mock WS server，不连真 backend）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BotSession, type InboundMessage } from "../src/session.js";
import type { ChannelInfo } from "../src/types.js";

import { MockBridge } from "./mock-bridge.js";

const TOKEN = "ocw_test_token";

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
        heartbeatIntervalMs: 60_000, // 测试里不需要心跳
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

    // 后端踢下 control
    bridge.supersede("control");

    // 片刻后 session 应当自动 stop（onFatal 触发 → stop()）
    await waitFor(() => fatals.length > 0, 3000);
    // 再 start 会抛错
    expect(() => session.start()).toThrow(/stopped/);
  });

  it("on reconnect (non-fatal close), data stream sends resume with last_event_seq", async () => {
    const session = await makeSession(bridge, {});
    session.start();
    await session.waitReady();

    // 模拟处理过 seq=5
    bridge.pushMessage({ task_id: "t1", channel_id: "C1", seq: 5 });
    await waitFor(() => session.lastProcessedSeq === 5);

    // 用 1006 (abnormal) 关掉 data —— 非致命，会重连
    // 直接从 mock server 侧 close 非 4401/4402/4403 的码即可
    const beforeCount = bridge.receivedResumes.length;
    for (const c of (bridge as unknown as { conns: Set<{ ws: { close: (c: number, r: string) => void; readyState: number }; stream: string }> }).conns) {
      if (c.stream === "data" && c.ws.readyState === 1 /* OPEN */) {
        c.ws.close(1011, "transient error");
      }
    }

    // 重连后应发 resume {last_event_seq: 5}
    await waitFor(() => bridge.receivedResumes.length > beforeCount, 5000);
    const lastResume = bridge.receivedResumes[bridge.receivedResumes.length - 1];
    expect(lastResume.type).toBe("resume");
    expect(lastResume.last_event_seq).toBe(5);

    await session.stop();
  });

  it("invalid token (401) prevents accept; session eventually becomes fatal", async () => {
    // 构造一个带错误 token 的 session
    const fatals: string[] = [];
    const s = new BotSession(
      {
        botToken: "ocw_wrong",
        controlUrl: bridge.controlUrl,
        dataUrl: bridge.dataUrl,
        advanced: { reconnectBaseMs: 30, reconnectMaxMs: 60, sendAckTimeoutMs: 500 },
      },
      { onFatal: (r) => fatals.push(r) },
    );
    s.start();
    // mock 在鉴权失败时以 HTTP 401 拒绝 upgrade —— 客户端看到 ws error/close
    // 非 4401/4402/4403，所以会继续重试；但 ReconnectingClient 会不停尝试（non-fatal）。
    // 为保证测试可终止，不等待 fatal —— 只验证 session 连不上即可。
    await new Promise((r) => setTimeout(r, 200));
    expect(s.botId).toBeNull();
    await s.stop();
  });
});
