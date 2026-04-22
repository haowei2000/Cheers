/**
 * outbound.sendMedia + sendText 行为单测。
 *
 * OpenClaw gateway (deliver-BNvlWd4P.js) 的调用合约：
 *   - 纯文本 payload → 串行调 handler.sendText(chunk)
 *   - 含 media payload → 仅 handler.sendMedia(caption, mediaUrl, overrides) 串行
 *     循环；caption 只在 index=0 非空，其后为 ""
 *   - 两者返回值都要有 { channel, messageId, chatId? } —— undefined 会让
 *     gateway 抛 "Cannot read properties of undefined (reading 'messageId')"
 *
 * 插件策略：sendMedia 上传二进制并按 `to` 累计 fileIds，debounce 500ms 后
 * 一次性 session.reply(caption, fileIds) flush；每次 sendMedia 立刻返回合成 id。
 */
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __testonly } from "../src/plugin.js";
import type { InboundMessage } from "../src/session.js";

const { sessionRegistry, sendText, sendMedia, pendingMediaByTo } = __testonly;

const ACCOUNT_ID = "acc-test";
const BOT_TOKEN = "ocw_test_token";
const DATA_URL = "ws://127.0.0.1:0/ws/openclaw/data";

function fakeInbound(taskId: string, channelId: string): InboundMessage {
  return {
    channelId,
    text: "hi",
    attachments: [],
    event: {
      type: "message",
      task_id: taskId,
      bot_id: "bot-x",
      channel_id: channelId,
      placeholder_msg_id: `ph-${taskId}`,
      trigger_message: { user: "u1", text: "@ws-bot do it", timestamp: "2026-04-21T00:00:00Z" },
      memory_context: {},
      attachments: [],
      binding_config: {},
    } as unknown as InboundMessage["event"],
  };
}

interface FakeSession {
  reply: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  membership: { channelIds: Set<string> };
}

function installFakeEntry(taskId: string, channelId: string): FakeSession {
  const inbound = fakeInbound(taskId, channelId);
  const session: FakeSession = {
    reply: vi.fn(async () => ({ ok: true, messageId: "msg-reply" })),
    send: vi.fn(async () => ({ ok: true, messageId: "msg-send" })),
    membership: { channelIds: new Set([channelId]) },
  };
  sessionRegistry.set(ACCOUNT_ID, {
    session: session as never,
    account: {
      accountId: ACCOUNT_ID,
      enabled: true,
      botToken: BOT_TOKEN,
      controlUrl: DATA_URL,
      dataUrl: DATA_URL,
      advanced: {
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30000,
        heartbeatIntervalMs: 30000,
        sendAckTimeoutMs: 10000,
      },
      allowFrom: [],
    },
    lastInboundBySessionKey: new Map([[`agentnexus:${ACCOUNT_ID}:${channelId}`, inbound]]),
    lastInboundByTaskId: new Map([[taskId, inbound]]),
    bindingStore: new Map(),
    bindingAdapter: {} as never,
  });
  return session;
}

describe("outbound.sendMedia + sendText (gateway deliver contract)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    sessionRegistry.clear();
    pendingMediaByTo.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    sessionRegistry.clear();
    pendingMediaByTo.clear();
  });

  it("sendMedia returns {channel,messageId,chatId} and flushes after debounce", async () => {
    const session = installFakeEntry("task-1", "C1");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const filePath = join(dir, "chart.png");
    await writeFile(filePath, Buffer.from("\x89PNG\r\n\x1a\npayload"));

    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ data: { file_id: "f-1" } }),
    } as Response);

    // gateway 合约：sendMedia(caption, mediaUrl, overrides) → 插件内部收到
    //   { to, text: caption, mediaUrl }
    const res = await sendMedia({
      to: "task-1", text: "这是图", mediaUrl: filePath, accountId: ACCOUNT_ID,
    });

    // 必须立即返回一个 messageId 字段，防 gateway `.messageId` 崩溃
    expect(res.channel).toBe("agentnexus");
    expect(typeof res.messageId).toBe("string");
    expect(res.messageId.length).toBeGreaterThan(0);
    expect(res.chatId).toBe("C1");

    // 上传 fetch 调用正确
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/files\/upload-binary$/);
    const h = init.headers as Record<string, string>;
    expect(h["X-Channel-Id"]).toBe("C1");
    expect(h["X-Filename"]).toBe("chart.png");

    // 此刻 session.reply 还没调用（等 debounce）
    expect(session.reply).not.toHaveBeenCalled();
    expect(pendingMediaByTo.get("task-1")?.fileIds).toEqual(["f-1"]);
    expect(pendingMediaByTo.get("task-1")?.caption).toBe("这是图");

    // debounce 触发
    await vi.advanceTimersByTimeAsync(600);

    expect(session.reply).toHaveBeenCalledTimes(1);
    const arg = session.reply.mock.calls[0][0];
    expect(arg.text).toBe("这是图");
    expect(arg.fileIds).toEqual(["f-1"]);
    expect(pendingMediaByTo.get("task-1")).toBeUndefined();
  });

  it("gateway 串行循环：多个 sendMedia 只最终 flush 一次 reply，合并 file_ids + 首个 caption", async () => {
    const session = installFakeEntry("task-2", "C1");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const f1 = join(dir, "a.png"); await writeFile(f1, "a");
    const f2 = join(dir, "b.pdf"); await writeFile(f2, "b");
    const f3 = join(dir, "c.txt"); await writeFile(f3, "c");

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { file_id: "fA" } }) } as Response);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { file_id: "fB" } }) } as Response);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { file_id: "fC" } }) } as Response);

    // gateway: i=0 有 caption；i>0 caption="" 或 undefined
    await sendMedia({ to: "task-2", text: "三个文件", mediaUrl: f1, accountId: ACCOUNT_ID });
    await sendMedia({ to: "task-2", text: "",        mediaUrl: f2, accountId: ACCOUNT_ID });
    await sendMedia({ to: "task-2",                  mediaUrl: f3, accountId: ACCOUNT_ID });

    // 循环中 reply 未发
    expect(session.reply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);

    expect(session.reply).toHaveBeenCalledTimes(1);
    const arg = session.reply.mock.calls[0][0];
    expect(arg.text).toBe("三个文件");
    expect(arg.fileIds).toEqual(["fA", "fB", "fC"]);
  });

  it("sendMedia upload 失败不阻止 gateway loop；返回带空 messageId", async () => {
    installFakeEntry("task-3", "C1");
    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const filePath = join(dir, "bad.png"); await writeFile(filePath, "bad");

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const res = await sendMedia({
      to: "task-3", text: "oops", mediaUrl: filePath, accountId: ACCOUNT_ID,
    });
    expect(res.channel).toBe("agentnexus");
    expect(res.messageId).toBe("");  // 空 string 也能让 gateway 安全读取
    expect(pendingMediaByTo.get("task-3")).toBeUndefined();
  });

  it("URL 形式的 mediaUrl 先下载再上传", async () => {
    installFakeEntry("task-4", "C1");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/pdf"]]) as unknown as Headers,
      arrayBuffer: async () => new ArrayBuffer(42),
    } as unknown as Response);
    fetchMock.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { file_id: "f-url" } }),
    } as Response);

    const res = await sendMedia({
      to: "task-4", text: "report",
      mediaUrl: "https://example.com/report.pdf", accountId: ACCOUNT_ID,
    });

    expect(res.messageId).toMatch(/^pending-media-/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, uploadInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const h = uploadInit.headers as Record<string, string>;
    expect(h["X-Filename"]).toBe("report.pdf");
    expect(h["Content-Type"]).toBe("application/pdf");
  });

  it("兼容旧 filePath 字段名（docs 示例命名，运行时已被 gateway 改名为 mediaUrl）", async () => {
    installFakeEntry("task-5", "C1");
    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const filePath = join(dir, "legacy.png"); await writeFile(filePath, "x");

    fetchMock.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { file_id: "f-legacy" } }),
    } as Response);

    const res = await sendMedia({
      to: "task-5", filePath, text: "legacy", accountId: ACCOUNT_ID,
    });
    expect(res.messageId.length).toBeGreaterThan(0);
    expect(pendingMediaByTo.get("task-5")?.fileIds).toEqual(["f-legacy"]);
  });

  it("纯文本路径：sendText 正常发一条 reply，不读 pending media", async () => {
    const session = installFakeEntry("task-6", "C1");

    const res = await sendText({ to: "task-6", text: "纯文本", accountId: ACCOUNT_ID });
    expect(res.channel).toBe("agentnexus");
    expect(res.messageId).toBe("msg-reply");
    expect(session.reply).toHaveBeenCalledTimes(1);
    expect(session.reply.mock.calls[0][0].fileIds).toBeUndefined();
  });
});
