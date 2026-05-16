/**
 * Unit tests for outbound.sendMedia and sendText behavior.
 *
 * OpenClaw gateway (deliver-BNvlWd4P.js) call contract:
 *   - text-only payloads call handler.sendText(chunk) serially
 *   - media payloads only call handler.sendMedia(caption, mediaUrl, overrides)
 *     serially; caption is non-empty only at index=0 and "" afterwards
 *   - both return values must include { channel, messageId, chatId? }; undefined
 *     makes the gateway throw "Cannot read properties of undefined (reading 'messageId')"
 *
 * Plugin strategy: sendMedia uploads binary data and accumulates fileIds by `to`.
 * After a 500ms debounce it flushes one session.reply(caption, fileIds). Each
 * sendMedia returns a synthetic id immediately.
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
  startOutputFallbackWatcher, pollOutputFallbackWatcher,
  outputFallbackWatchers, resolveOutputFallbackConfig,
  notifyOpenClawRunTerminal, registerOpenClawRunTrace,
} = __testonly;

const ACCOUNT_ID = "acc-test";
const BOT_TOKEN = "agb_test_token";
const DATA_URL = "ws://127.0.0.1:0/ws/agent-bridge/data";

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
  uploadFile: ReturnType<typeof vi.fn>;
  membership: { channelIds: Set<string> };
}

function installFakeEntry(taskId: string, channelId: string, opts: { placeholder?: string | null } = {}): FakeSession {
  const inbound = fakeInbound(taskId, channelId);
  if ("placeholder" in opts) {
    (inbound.event as { placeholder_msg_id: string | null }).placeholder_msg_id = opts.placeholder ?? null;
  }
  const replyTarget = {
    taskId,
    placeholderMsgId: inbound.event.placeholder_msg_id ?? null,
    channelId,
    sessionKey: `agentnexus:${ACCOUNT_ID}:${channelId}`,
    source: inbound,
  };
  const session: FakeSession = {
    reply: vi.fn(async () => ({ ok: true, messageId: "msg-reply" })),
    send: vi.fn(async () => ({ ok: true, messageId: "msg-send" })),
    streamDelta: vi.fn(() => true),
    streamDone: vi.fn(() => true),
    streamError: vi.fn(() => true),
    // Default: upload fails — individual tests override via mockResolvedValueOnce.
    // This keeps the "upload failed" test honest without per-test wiring.
    uploadFile: vi.fn(async () => ({
      type: "file_upload_ack", client_file_id: null, ok: false,
      code: "no_mock", error: "uploadFile not mocked in this test",
    })),
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
    replyTargets: new Map([
      [taskId, replyTarget],
      [`agentnexus:${ACCOUNT_ID}:${channelId}`, replyTarget],
    ]),
    bindingStore: new Map(),
    bindingAdapter: {} as never,
  });
  return session;
}

function markDeliverableRequest(taskId: string): void {
  const entry = sessionRegistry.get(ACCOUNT_ID)!;
  const source = entry.lastInboundByTaskId.get(taskId)!;
  source.text = [
    'Use the "mes-sales-consultant" skill for this request.',
    "",
    "User input:",
    "武汉瑞和汽车调研报告",
  ].join("\n");
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
    outputFallbackWatchers.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    sessionRegistry.clear();
    pendingMediaByTo.clear();
    pendingStreamByTo.clear();
    taskByPlaceholder.clear();
    outputFallbackWatchers.clear();
  });

  it("sendMedia 走流式槽：caption 当作单 delta 推送，debounce 后 done 携带 fileIds", async () => {
    const session = installFakeEntry("task-1", "C1");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const filePath = join(dir, "chart.png");
    await writeFile(filePath, Buffer.from("\x89PNG\r\n\x1a\npayload"));

    session.uploadFile.mockResolvedValueOnce({
      type: "file_upload_ack", client_file_id: "c-1", ok: true, file_id: "f-1",
    });

    const res = await sendMedia({
      to: "task-1", text: "这是图", mediaUrl: filePath, accountId: ACCOUNT_ID,
    });

    expect(res.channel).toBe("agentnexus");
    expect(typeof res.messageId).toBe("string");
    expect(res.messageId.length).toBeGreaterThan(0);
    expect(res.chatId).toBe("C1");

    expect(session.uploadFile).toHaveBeenCalledTimes(1);
    expect(session.uploadFile.mock.calls[0][0]).toMatchObject({
      channelId: "C1", filename: "chart.png",
    });

    // Caption goes through streamDelta and files are stored in the stream slot; the legacy reply path is skipped.
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

    session.uploadFile.mockResolvedValueOnce({ type: "file_upload_ack", client_file_id: "cA", ok: true, file_id: "fA" });
    session.uploadFile.mockResolvedValueOnce({ type: "file_upload_ack", client_file_id: "cB", ok: true, file_id: "fB" });
    session.uploadFile.mockResolvedValueOnce({ type: "file_upload_ack", client_file_id: "cC", ok: true, file_id: "fC" });

    await sendMedia({ to: "task-2", text: "三个文件", mediaUrl: f1, accountId: ACCOUNT_ID });
    await sendMedia({ to: "task-2", text: "",        mediaUrl: f2, accountId: ACCOUNT_ID });
    await sendMedia({ to: "task-2",                  mediaUrl: f3, accountId: ACCOUNT_ID });

    // The loop has one caption delta and no done/reply yet.
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
    const session = installFakeEntry("task-3", "C1");
    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const filePath = join(dir, "bad.png"); await writeFile(filePath, "bad");

    session.uploadFile.mockResolvedValueOnce({
      type: "file_upload_ack", client_file_id: "c-bad", ok: false,
      code: "ws_send_failed", error: "boom",
    });

    const res = await sendMedia({
      to: "task-3", text: "oops", mediaUrl: filePath, accountId: ACCOUNT_ID,
    });
    expect(res.channel).toBe("agentnexus");
    expect(res.messageId).toBe("");
    expect(pendingMediaByTo.get("task-3")).toBeUndefined();
    // Failed uploads must not leave empty slots or consume the inbound source.
    expect(pendingStreamByTo.get("task-3")).toBeUndefined();
  });

  it("URL 形式的 mediaUrl 先下载再上传，再投到流式槽", async () => {
    const session = installFakeEntry("task-4", "C1");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/pdf"]]) as unknown as Headers,
      arrayBuffer: async () => new ArrayBuffer(42),
    } as unknown as Response);
    session.uploadFile.mockResolvedValueOnce({
      type: "file_upload_ack", client_file_id: "c-url", ok: true, file_id: "f-url",
    });

    const res = await sendMedia({
      to: "task-4", text: "report",
      mediaUrl: "https://example.com/report.pdf", accountId: ACCOUNT_ID,
    });

    // The streaming slot path now returns messageId like `${placeholder}-f1`.
    expect(res.messageId).toBe("ph-task-4-f1");
    expect(fetchMock).toHaveBeenCalledTimes(1);    // download only
    expect(session.uploadFile).toHaveBeenCalledTimes(1);
    expect(session.uploadFile.mock.calls[0][0]).toMatchObject({
      channelId: "C1",
      filename: "report.pdf",
      contentType: "application/pdf",
    });
    expect(pendingStreamByTo.get("task-4")?.fileIds).toEqual(["f-url"]);
  });

  it("兼容旧 filePath 字段名（docs 示例命名，运行时已被 gateway 改名为 mediaUrl）", async () => {
    const session = installFakeEntry("task-5", "C1");
    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const filePath = join(dir, "legacy.png"); await writeFile(filePath, "x");

    session.uploadFile.mockResolvedValueOnce({
      type: "file_upload_ack", client_file_id: "c-legacy", ok: true, file_id: "f-legacy",
    });

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

    // reply is not called because the whole path uses streamDelta.
    expect(session.reply).not.toHaveBeenCalled();
    expect(session.streamDelta).toHaveBeenCalledTimes(3);
    const deltaArgs = session.streamDelta.mock.calls.map((c) => c[0]);
    expect(deltaArgs[0]).toMatchObject({ msgId: "ph-task-6", seq: 1, delta: "你" });
    expect(deltaArgs[1]).toMatchObject({ msgId: "ph-task-6", seq: 2, delta: "好" });
    expect(deltaArgs[2]).toMatchObject({ msgId: "ph-task-6", seq: 3, delta: "吗" });

    // done is still waiting on debounce.
    expect(session.streamDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({ msgId: "ph-task-6" });

    // The slot is cleaned up.
    expect(pendingStreamByTo.get("task-6")).toBeUndefined();
    expect(taskByPlaceholder.get("ph-task-6")).toBeUndefined();
  });

  it("报告类任务的纯状态句会静默挂起，等待后台 task 和后续产物", async () => {
    const session = installFakeEntry("task-status", "C1");
    markDeliverableRequest("task-status");

    const res = await sendText({
      to: "task-status",
      text: "正在生成瑞和汽车系统诊断报告，基于公开信息完成行业特征×工艺特点×运营模式三维分析...",
      accountId: ACCOUNT_ID,
    });

    expect(res.messageId).toBe("ph-task-status-held-status");
    expect(session.streamDelta).not.toHaveBeenCalled();
    expect(session.streamDone).not.toHaveBeenCalled();
    expect(session.streamError).not.toHaveBeenCalled();
    expect(pendingStreamByTo.get("task-status")?.heldStatusText).toContain("正在生成瑞和汽车系统诊断报告");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(session.streamDelta).not.toHaveBeenCalled();
    expect(session.streamError).not.toHaveBeenCalled();
    expect(session.streamDone).not.toHaveBeenCalled();
    expect(pendingStreamByTo.get("task-status")).toBeDefined();
  });

  it("报告类任务只输出状态句但 run 已结束时会失败收尾", async () => {
    const session = installFakeEntry("task-status-terminal", "C1");
    markDeliverableRequest("task-status-terminal");
    registerOpenClawRunTrace({
      runId: "run-status-terminal",
      accountId: ACCOUNT_ID,
      sessionKey: "agent:agentnexus-local:agentnexus:account:acc-test:session:test",
      channelId: "C1",
      taskId: "task-status-terminal",
      placeholderMsgId: "ph-task-status-terminal",
    });

    await sendText({
      to: "task-status-terminal",
      text: "Now I have enough context. Let me generate the HTML report.",
      accountId: ACCOUNT_ID,
    });

    expect(session.streamDelta).not.toHaveBeenCalled();
    expect(session.streamError).not.toHaveBeenCalled();
    expect(pendingStreamByTo.get("task-status-terminal")?.heldStatusText).toContain("Let me generate");

    notifyOpenClawRunTerminal({
      runId: "run-status-terminal",
      accountId: ACCOUNT_ID,
      taskId: "task-status-terminal",
      status: "ok",
    });
    await vi.advanceTimersByTimeAsync(600);

    expect(session.streamDelta).toHaveBeenCalledTimes(1);
    expect(session.streamDelta.mock.calls[0][0]).toMatchObject({
      msgId: "ph-task-status-terminal",
    });
    expect(String(session.streamDelta.mock.calls[0][0].delta)).toContain("没有生成可交付正文或附件");
    expect(session.streamError).toHaveBeenCalledTimes(1);
    expect(session.streamError.mock.calls[0][0]).toMatchObject({
      msgId: "ph-task-status-terminal",
    });
    expect(pendingStreamByTo.get("task-status-terminal")).toBeUndefined();
  });

  it("状态句后接真正正文时丢弃状态句并正常完成", async () => {
    const session = installFakeEntry("task-status-then-body", "C1");
    markDeliverableRequest("task-status-then-body");

    await sendText({
      to: "task-status-then-body",
      text: "正在生成瑞和汽车系统诊断报告...",
      accountId: ACCOUNT_ID,
    });
    await sendText({
      to: "task-status-then-body",
      text: "\n# 瑞和汽车系统诊断报告\n\n正文要点：产线、质量、设备与售后协同。",
      accountId: ACCOUNT_ID,
    });

    expect(session.streamDelta).toHaveBeenCalledTimes(1);
    expect(session.streamDelta.mock.calls[0][0]).toMatchObject({
      msgId: "ph-task-status-then-body",
      seq: 1,
      delta: "\n# 瑞和汽车系统诊断报告\n\n正文要点：产线、质量、设备与售后协同。",
    });
    expect(session.streamError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);

    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({ msgId: "ph-task-status-then-body" });
  });

  it("报告类正文结束时等待 output 文件稳定并把文件合并到 done", async () => {
    const session = installFakeEntry("task-text-output", "C1");
    markDeliverableRequest("task-text-output");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-output-after-text-"));
    const filePath = join(dir, "瑞和汽车MES售前报告.md");
    const entry = sessionRegistry.get(ACCOUNT_ID)!;
    entry.account.outputFallback = resolveOutputFallbackConfig({
      outputDirs: [dir],
      delayMs: 10_000,
      pollMs: 50,
      stableMs: 100,
      postStreamWatchMs: 1_000,
      minBytes: 1,
      maxWatchMs: 5_000,
    });
    const source = entry.lastInboundByTaskId.get("task-text-output")!;
    await startOutputFallbackWatcher(
      entry,
      ACCOUNT_ID,
      source,
      `agent:agentnexus-local:agentnexus:account:${ACCOUNT_ID}:session:test`,
    );

    await sendText({
      to: "task-text-output",
      text: "报告已生成，保存在 `瑞和汽车MES售前报告.md`。",
      accountId: ACCOUNT_ID,
    });
    await writeFile(filePath, "# 瑞和汽车MES售前报告\n\n正文");
    session.uploadFile.mockResolvedValueOnce({
      type: "file_upload_ack", client_file_id: "c-output", ok: true, file_id: "f-output",
    });

    await pollOutputFallbackWatcher(`${ACCOUNT_ID}:task-text-output`, entry);
    await vi.advanceTimersByTimeAsync(120);
    await pollOutputFallbackWatcher(`${ACCOUNT_ID}:task-text-output`, entry);

    expect(session.uploadFile).toHaveBeenCalledTimes(1);
    expect(session.streamDone).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);

    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({
      msgId: "ph-task-text-output",
      fileIds: ["f-output"],
    });
    expect(outputFallbackWatchers.get(`${ACCOUNT_ID}:task-text-output`)).toBeUndefined();
  });

  it("报告类正文结束但没有 output 文件时会在收尾窗口后完成 done", async () => {
    const session = installFakeEntry("task-text-no-output", "C1");
    markDeliverableRequest("task-text-no-output");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-no-output-"));
    const entry = sessionRegistry.get(ACCOUNT_ID)!;
    entry.account.outputFallback = resolveOutputFallbackConfig({
      outputDirs: [dir],
      delayMs: 10_000,
      pollMs: 50,
      stableMs: 100,
      postStreamWatchMs: 300,
      minBytes: 1,
      maxWatchMs: 5_000,
    });
    const source = entry.lastInboundByTaskId.get("task-text-no-output")!;
    await startOutputFallbackWatcher(
      entry,
      ACCOUNT_ID,
      source,
      `agent:agentnexus-local:agentnexus:account:${ACCOUNT_ID}:session:test`,
    );

    await sendText({
      to: "task-text-no-output",
      text: "# 瑞和汽车MES售前报告\n\n正文已经直接输出。",
      accountId: ACCOUNT_ID,
    });

    await vi.advanceTimersByTimeAsync(550);
    expect(session.streamDone).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({ msgId: "ph-task-text-no-output" });
    expect(outputFallbackWatchers.get(`${ACCOUNT_ID}:task-text-no-output`)).toBeUndefined();
  });

  it("子 conversation 输出继续写回父 placeholder", async () => {
    const session = installFakeEntry("task-child-parent", "C1");
    const entry = sessionRegistry.get(ACCOUNT_ID)!;
    const parentTarget = entry.replyTargets.get("task-child-parent")!;
    entry.replyTargets.set("child-conversation-1", parentTarget);

    await sendText({ to: "child-conversation-1", text: "子", accountId: ACCOUNT_ID });
    await sendText({ to: "child-conversation-1", text: "Bot", accountId: ACCOUNT_ID });

    expect(session.streamDelta).toHaveBeenCalledTimes(2);
    expect(session.streamDelta.mock.calls[0][0]).toMatchObject({
      msgId: "ph-task-child-parent", seq: 1, delta: "子",
    });
    expect(session.streamDelta.mock.calls[1][0]).toMatchObject({
      msgId: "ph-task-child-parent", seq: 2, delta: "Bot",
    });
    expect(pendingStreamByTo.get("task-child-parent")).toBeDefined();
    expect(pendingStreamByTo.get("child-conversation-1")).toBeUndefined();
    expect(taskByPlaceholder.get("ph-task-child-parent")).toBe("task-child-parent");

    await vi.advanceTimersByTimeAsync(600);
    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({
      msgId: "ph-task-child-parent",
    });
  });

  it("binding metadata 可把 child conversation 解析回父 placeholder", async () => {
    const session = installFakeEntry("task-binding-parent", "C1");
    const entry = sessionRegistry.get(ACCOUNT_ID)!;
    entry.replyTargets.delete("child-binding-1");
    entry.bindingStore.set("sk-child", [
      {
        bindingId: "binding-child-1",
        targetSessionKey: "sk-child",
        targetKind: "subagent",
        conversation: {
          channel: "agentnexus",
          accountId: ACCOUNT_ID,
          conversationId: "child-binding-1",
          parentConversationId: "task-binding-parent",
        },
        status: "active",
        boundAt: Date.now(),
        metadata: {
          agentnexusTaskId: "task-binding-parent",
          placeholderMsgId: null,
          channelId: "C1",
          sessionKey: "sk-child",
        },
      },
    ]);

    await sendText({ to: "child-binding-1", text: "绑定", accountId: ACCOUNT_ID });

    expect(session.streamDelta).toHaveBeenCalledTimes(1);
    expect(session.streamDelta.mock.calls[0][0]).toMatchObject({
      msgId: "ph-task-binding-parent",
      seq: 1,
      delta: "绑定",
    });
    expect(pendingStreamByTo.get("task-binding-parent")).toBeDefined();
  });

  it("流式路径：data WS streamDelta 返回 false 时降级到 session.reply", async () => {
    const session = installFakeEntry("task-7", "C1");
    session.streamDelta.mockReturnValueOnce(false);  // WS 写失败

    const res = await sendText({ to: "task-7", text: "断了", accountId: ACCOUNT_ID });
    // One reply fallback returns the real messageId.
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

    // Simulate control WS cancel by setting slot.cancelled = true directly.
    const slot = pendingStreamByTo.get("task-9");
    expect(slot).toBeDefined();
    slot!.cancelled = true;
    if (slot!.doneTimer) {
      clearTimeout(slot!.doneTimer);
      slot!.doneTimer = null;
    }

    // Later chunks no longer push deltas.
    await sendText({ to: "task-9", text: "second", accountId: ACCOUNT_ID });
    await sendText({ to: "task-9", text: "third", accountId: ACCOUNT_ID });
    expect(session.streamDelta).toHaveBeenCalledTimes(1);

    // Debounce fires, but done must not be sent because the server already finalized the partial response.
    await vi.advanceTimersByTimeAsync(600);
    expect(session.streamDone).not.toHaveBeenCalled();
  });

  it("混合模式：sendText 流文本 + sendMedia 加文件 → 一个 done 同时带 fileIds", async () => {
    const session = installFakeEntry("task-mix", "C1");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const f1 = join(dir, "chart.png"); await writeFile(f1, "p");

    session.uploadFile.mockResolvedValueOnce({
      type: "file_upload_ack", client_file_id: "cMix", ok: true, file_id: "fMix",
    });

    // Stream text tokens first.
    await sendText({ to: "task-mix", text: "Here ", accountId: ACCOUNT_ID });
    await sendText({ to: "task-mix", text: "you go.", accountId: ACCOUNT_ID });
    // Then sendMedia with an empty caption; mixed mode should not push caption as another delta.
    await sendMedia({ to: "task-mix", text: "", mediaUrl: f1, accountId: ACCOUNT_ID });

    // Only the two sendText deltas are emitted; sendMedia skips caption because deltas already exist.
    expect(session.streamDelta).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(600);

    // Only one done is emitted, including files accumulated with the text deltas.
    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({
      msgId: "ph-task-mix", fileIds: ["fMix"],
    });
    expect(session.reply).not.toHaveBeenCalled();
  });

  it("source-less 广播：bot 主动发 channel 文件 → 走老 pendingMediaByTo + session.send 兜底", async () => {
    const session = installFakeEntry("task-bcast", "C1");
    // Simulate an already consumed source for bot-initiated sends without an inbound trigger.
    sessionRegistry.get(ACCOUNT_ID)!.lastInboundByTaskId.clear();

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-media-"));
    const fp = join(dir, "broadcast.png"); await writeFile(fp, "x");

    session.uploadFile.mockResolvedValueOnce({
      type: "file_upload_ack", client_file_id: "cBC", ok: true, file_id: "fBC",
    });

    // ctx.to passes channelId directly; the bot is a channel member, so use source-less fallback.
    const res = await sendMedia({
      to: "C1", text: "hi all", mediaUrl: fp, accountId: ACCOUNT_ID,
    });

    expect(res.messageId).toMatch(/^pending-media-/);
    expect(pendingMediaByTo.get("C1")?.fileIds).toEqual(["fBC"]);
    // The streaming slot remains untouched.
    expect(pendingStreamByTo.get("C1")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(600);

    // Use session.send rather than streamDelta/streamDone.
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.send.mock.calls[0][0]).toMatchObject({
      channelId: "C1", text: "hi all", fileIds: ["fBC"],
    });
    expect(session.streamDelta).not.toHaveBeenCalled();
    expect(session.streamDone).not.toHaveBeenCalled();
  });

  it("报告类后台任务发现稳定完整 output 文件后自动上传并 done", async () => {
    const session = installFakeEntry("task-output", "C1");
    markDeliverableRequest("task-output");

    const dir = await mkdtemp(join(tmpdir(), "agentnexus-output-"));
    const filePath = join(dir, "瑞和汽车系统调研报告.html");
    const entry = sessionRegistry.get(ACCOUNT_ID)!;
    entry.account.outputFallback = resolveOutputFallbackConfig({
      outputDirs: [dir],
      delayMs: 1,
      pollMs: 50,
      stableMs: 100,
      minBytes: 1,
      maxWatchMs: 5_000,
    });

    const source = entry.lastInboundByTaskId.get("task-output")!;
    await startOutputFallbackWatcher(
      entry,
      ACCOUNT_ID,
      source,
      `agent:agentnexus-local:agentnexus:account:${ACCOUNT_ID}:session:test`,
    );

    await writeFile(filePath, "<html><body><h1>报告</h1></body></html>");
    session.uploadFile.mockResolvedValueOnce({
      type: "file_upload_ack", client_file_id: "c-output", ok: true, file_id: "f-output",
    });

    await pollOutputFallbackWatcher(`${ACCOUNT_ID}:task-output`, entry);
    expect(session.uploadFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120);
    await pollOutputFallbackWatcher(`${ACCOUNT_ID}:task-output`, entry);
    expect(session.uploadFile).toHaveBeenCalledTimes(1);
    expect(session.uploadFile.mock.calls[0][0]).toMatchObject({
      channelId: "C1",
      filename: "瑞和汽车系统调研报告.html",
      contentType: "text/html; charset=utf-8",
    });
    expect(session.streamDelta).toHaveBeenCalledTimes(1);
    expect(session.streamDelta.mock.calls[0][0]).toMatchObject({
      msgId: "ph-task-output",
      delta: "已生成文件，请查收附件：瑞和汽车系统调研报告.html",
    });

    await vi.advanceTimersByTimeAsync(600);

    expect(session.streamDone).toHaveBeenCalledTimes(1);
    expect(session.streamDone.mock.calls[0][0]).toEqual({
      msgId: "ph-task-output",
      fileIds: ["f-output"],
    });
    expect(outputFallbackWatchers.get(`${ACCOUNT_ID}:task-output`)).toBeUndefined();
  });
});
