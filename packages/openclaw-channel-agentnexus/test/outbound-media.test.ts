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

const {
  sessionRegistry, sendText, sendMedia, pendingMediaByTo,
  pendingStreamByTo, taskByPlaceholder,
} = __testonly;

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
  streamDelta: ReturnType<typeof vi.fn>;
  streamDone: ReturnType<typeof vi.fn>;
  streamError: ReturnType<typeof vi.fn>;
  membership: { channelIds: Set<string> };
}

function installFakeEntry(taskId: string, channelId: string, opts: { placeholder?: string | null } = {}): FakeSession {
  const inbound = fakeInbound(taskId, channelId);
  if ("placeholder" in opts) {
    (inbound.event as { placeholder_msg_id: string | null }).placeholder_msg_id = opts.placeholder ?? null;
  }
  const session: FakeSession = {
    reply: vi.fn(async () => ({ ok: true, messageId: "msg-reply" })),
    send: vi.fn(async () => ({ ok: true, messageId: "msg-send" })),
    streamDelta: vi.fn(() => true),
    streamDone: vi.fn(() => true),
    streamError: vi.fn(() => true),
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
    pendingStreamByTo.clear();
    taskByPlaceholder.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    sessionRegistry.clear();
    pendingMediaByTo.clear();
    pendingStreamByTo.clear();
    taskByPlaceholder.clear();
  });

  it("sendMedia 走流式槽：caption 当作单 delta 推送，debounce 后 done 携带 fileIds", async () => {
    const session = installFakeEntry("task-1", "C1");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const filePath = join(dir, "chart.png");
    await writeFile(filePath, Buffer.from("\x89PNG\r\n\x1a\npayload"));

    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ data: { file_id: "f-1" } }),
    } as Response);

    const res = await sendMedia({
      to: "task-1", text: "这是图", mediaUrl: filePath, accountId: ACCOUNT_ID,
    });

    expect(res.channel).toBe("agentnexus");
    expect(typeof res.messageId).toBe("string");
    expect(res.messageId.length).toBeGreaterThan(0);
    expect(res.chatId).toBe("C1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/files\/upload-binary$/);
    const h = init.headers as Record<string, string>;
    expect(h["X-Channel-Id"]).toBe("C1");
    expect(h["X-Filename"]).toBe("chart.png");

    // caption 走 streamDelta，文件存进 stream slot；不再走老 reply 路径
    expect(session.reply).not.toHaveBeenCalled();
    expect(session.streamDelta).toHaveBeenCalledTimes(1);
    expect(session.streamDelta.mock.calls[0][0]).toMatchObject({
      msgId: "ph-task-1", seq: 1, delta: "这是图",
    });
    expect(pendingStreamByTo.get("task-1")?.fileIds).toEqual(["f-1"]);
    expect(pendingMediaByTo.get("task-1")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(600);

    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({
      msgId: "ph-task-1", fileIds: ["f-1"],
    });
    expect(pendingStreamByTo.get("task-1")).toBeUndefined();
  });

  it("gateway 串行循环：多个 sendMedia 合并到一个 streamDone，fileIds 全数携带", async () => {
    const session = installFakeEntry("task-2", "C1");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const f1 = join(dir, "a.png"); await writeFile(f1, "a");
    const f2 = join(dir, "b.pdf"); await writeFile(f2, "b");
    const f3 = join(dir, "c.txt"); await writeFile(f3, "c");

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { file_id: "fA" } }) } as Response);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { file_id: "fB" } }) } as Response);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { file_id: "fC" } }) } as Response);

    await sendMedia({ to: "task-2", text: "三个文件", mediaUrl: f1, accountId: ACCOUNT_ID });
    await sendMedia({ to: "task-2", text: "",        mediaUrl: f2, accountId: ACCOUNT_ID });
    await sendMedia({ to: "task-2",                  mediaUrl: f3, accountId: ACCOUNT_ID });

    // 循环中只有一个 caption delta，而且没有 done 也没有 reply
    expect(session.reply).not.toHaveBeenCalled();
    expect(session.streamDone).not.toHaveBeenCalled();
    expect(session.streamDelta).toHaveBeenCalledTimes(1);
    expect(session.streamDelta.mock.calls[0][0]).toMatchObject({ delta: "三个文件" });

    await vi.advanceTimersByTimeAsync(600);

    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({
      msgId: "ph-task-2", fileIds: ["fA", "fB", "fC"],
    });
  });

  it("sendMedia upload 失败不阻止 gateway loop；返回带空 messageId，且不消费 inbound", async () => {
    installFakeEntry("task-3", "C1");
    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const filePath = join(dir, "bad.png"); await writeFile(filePath, "bad");

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const res = await sendMedia({
      to: "task-3", text: "oops", mediaUrl: filePath, accountId: ACCOUNT_ID,
    });
    expect(res.channel).toBe("agentnexus");
    expect(res.messageId).toBe("");
    expect(pendingMediaByTo.get("task-3")).toBeUndefined();
    // 上传失败时不能为空槽，inbound source 也不能被消费
    expect(pendingStreamByTo.get("task-3")).toBeUndefined();
  });

  it("URL 形式的 mediaUrl 先下载再上传，再投到流式槽", async () => {
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

    // 现在走流式槽，messageId 形如 `${placeholder}-f1`
    expect(res.messageId).toBe("ph-task-4-f1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, uploadInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const h = uploadInit.headers as Record<string, string>;
    expect(h["X-Filename"]).toBe("report.pdf");
    expect(h["Content-Type"]).toBe("application/pdf");
    expect(pendingStreamByTo.get("task-4")?.fileIds).toEqual(["f-url"]);
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
    expect(pendingStreamByTo.get("task-5")?.fileIds).toEqual(["f-legacy"]);
  });

  it("流式路径：每个 sendText chunk 发一个 delta，最后 debounce 出一个 done", async () => {
    const session = installFakeEntry("task-6", "C1");

    await sendText({ to: "task-6", text: "你", accountId: ACCOUNT_ID });
    await sendText({ to: "task-6", text: "好", accountId: ACCOUNT_ID });
    await sendText({ to: "task-6", text: "吗", accountId: ACCOUNT_ID });

    // reply 不被调用 —— 全程靠 streamDelta
    expect(session.reply).not.toHaveBeenCalled();
    expect(session.streamDelta).toHaveBeenCalledTimes(3);
    const deltaArgs = session.streamDelta.mock.calls.map((c) => c[0]);
    expect(deltaArgs[0]).toMatchObject({ msgId: "ph-task-6", seq: 1, delta: "你" });
    expect(deltaArgs[1]).toMatchObject({ msgId: "ph-task-6", seq: 2, delta: "好" });
    expect(deltaArgs[2]).toMatchObject({ msgId: "ph-task-6", seq: 3, delta: "吗" });

    // done 还在 debounce 中
    expect(session.streamDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({ msgId: "ph-task-6" });

    // 槽位清干净
    expect(pendingStreamByTo.get("task-6")).toBeUndefined();
    expect(taskByPlaceholder.get("ph-task-6")).toBeUndefined();
  });

  it("流式路径：data WS streamDelta 返回 false 时降级到 session.reply", async () => {
    const session = installFakeEntry("task-7", "C1");
    session.streamDelta.mockReturnValueOnce(false);  // WS 写失败

    const res = await sendText({ to: "task-7", text: "断了", accountId: ACCOUNT_ID });
    // 一次 reply 兜底，return 真实 messageId
    expect(session.reply).toHaveBeenCalledTimes(1);
    expect(res.messageId).toBe("msg-reply");
    expect(pendingStreamByTo.get("task-7")).toBeUndefined();
  });

  it("无 placeholder 的 inbound：直接走老的 reply 路径，不发 stream 帧", async () => {
    const session = installFakeEntry("task-8", "C1", { placeholder: null });

    const res = await sendText({ to: "task-8", text: "Hi", accountId: ACCOUNT_ID });
    expect(session.reply).toHaveBeenCalledTimes(1);
    expect(session.streamDelta).not.toHaveBeenCalled();
    expect(session.streamDone).not.toHaveBeenCalled();
    expect(res.messageId).toBe("msg-reply");
  });

  it("取消：slot.cancelled 后续 sendText 不再推 delta，也不发 done", async () => {
    const session = installFakeEntry("task-9", "C1");

    await sendText({ to: "task-9", text: "first", accountId: ACCOUNT_ID });
    expect(session.streamDelta).toHaveBeenCalledTimes(1);

    // 模拟 control WS 推 cancel：直接打 slot.cancelled = true
    const slot = pendingStreamByTo.get("task-9");
    expect(slot).toBeDefined();
    slot!.cancelled = true;
    if (slot!.doneTimer) {
      clearTimeout(slot!.doneTimer);
      slot!.doneTimer = null;
    }

    // 后续 chunk：不再推 delta
    await sendText({ to: "task-9", text: "second", accountId: ACCOUNT_ID });
    await sendText({ to: "task-9", text: "third", accountId: ACCOUNT_ID });
    expect(session.streamDelta).toHaveBeenCalledTimes(1);

    // debounce 触发 —— 也不能发 done（服务端已 finalize partial）
    await vi.advanceTimersByTimeAsync(600);
    expect(session.streamDone).not.toHaveBeenCalled();
  });

  it("混合模式：sendText 流文本 + sendMedia 加文件 → 一个 done 同时带 fileIds", async () => {
    const session = installFakeEntry("task-mix", "C1");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const f1 = join(dir, "chart.png"); await writeFile(f1, "p");

    fetchMock.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { file_id: "fMix" } }),
    } as Response);

    // 先流 token
    await sendText({ to: "task-mix", text: "Here ", accountId: ACCOUNT_ID });
    await sendText({ to: "task-mix", text: "you go.", accountId: ACCOUNT_ID });
    // 然后 sendMedia 带空 caption（混合模式下 caption 不应被作为 delta 重推）
    await sendMedia({ to: "task-mix", text: "", mediaUrl: f1, accountId: ACCOUNT_ID });

    // 只有 sendText 的两次 delta，sendMedia 因为已经有 deltas 不再推 caption
    expect(session.streamDelta).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(600);

    // 只有一个 done，同时带文本 deltas 累积的文件
    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({
      msgId: "ph-task-mix", fileIds: ["fMix"],
    });
    expect(session.reply).not.toHaveBeenCalled();
  });

  it("source-less 广播：bot 主动发 channel 文件 → 走老 pendingMediaByTo + session.send 兜底", async () => {
    const session = installFakeEntry("task-bcast", "C1");
    // 模拟 source 已被消费完毕（bot 主动发，没有触发它的入站消息）
    sessionRegistry.get(ACCOUNT_ID)!.lastInboundByTaskId.clear();

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const fp = join(dir, "broadcast.png"); await writeFile(fp, "x");

    fetchMock.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { file_id: "fBC" } }),
    } as Response);

    // ctx.to 直接传 channelId（bot 是 channel 成员），走 source-less 兜底
    const res = await sendMedia({
      to: "C1", text: "hi all", mediaUrl: fp, accountId: ACCOUNT_ID,
    });

    expect(res.messageId).toMatch(/^pending-media-/);
    expect(pendingMediaByTo.get("C1")?.fileIds).toEqual(["fBC"]);
    // 不会污染流式槽
    expect(pendingStreamByTo.get("C1")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(600);

    // 走 session.send，不走 streamDelta/streamDone
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.send.mock.calls[0][0]).toMatchObject({
      channelId: "C1", text: "hi all", fileIds: ["fBC"],
    });
    expect(session.streamDelta).not.toHaveBeenCalled();
    expect(session.streamDone).not.toHaveBeenCalled();
  });
});
