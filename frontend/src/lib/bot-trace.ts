import type { BotTraceEvent, Message } from "../types";

const CLIENT_STREAM_TRACE = "agentnexus_client";
const MAX_BOT_TRACE_EVENTS = 160;

export function trimBotTraceEvents(events: BotTraceEvent[]): BotTraceEvent[] {
  return events.slice(-MAX_BOT_TRACE_EVENTS);
}

export function traceTimeLabel(ts?: number): string {
  if (!ts) return "";
  const ms = ts > 1_000_000_000_000 ? ts : ts > 1_000_000_000 ? ts * 1000 : ts;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function streamTraceLabel(trace: BotTraceEvent): string {
  if (trace.stream !== CLIENT_STREAM_TRACE) return botTraceStatusText(trace);
  const phase = trace.phase || "";
  const labels: Record<string, string> = {
    placeholder: "创建 Bot 回复占位",
    message_stream: "收到流式片段",
    message_done: "流式回复完成",
    message_done_partial: "流式回复中断",
    message_done_error: "流式回复出错",
  };
  return [labels[phase] || trace.title || "流式事件", trace.message]
    .filter(Boolean)
    .join(" · ");
}

export function makeClientStreamTrace(
  message: Pick<Message, "msg_id" | "task_id" | "sender_id">,
  phase: string,
  title: string,
  data?: Record<string, unknown>,
  messageText?: string,
): BotTraceEvent {
  return {
    msg_id: message.msg_id,
    task_id: message.task_id || null,
    bot_id: message.sender_id,
    stream: CLIENT_STREAM_TRACE,
    phase,
    title,
    message: messageText,
    ts: Date.now(),
    data,
  };
}

export function botTraceStatusText(trace: BotTraceEvent): string {
  const stream = trace.stream || "trace";
  const phase = trace.phase || "";
  const title = trace.title || "";
  const message = trace.message || "";
  if (stream === "agentnexus_plugin") {
    const labels: Record<string, string> = {
      received: "插件已收到消息",
      hydrating_attachments: "正在读取附件",
      attachments_ready: "附件已准备好",
      loopback_start: "正在启动 provider",
      loopback_accepted: "provider 已接收任务",
      loopback_error: "provider 路由异常",
      subagent_run_started: "provider run 已启动",
      subagent_run_error: "provider run 启动失败",
    };
    return [labels[phase] || title || "插件处理中", message].filter(Boolean).join(" · ");
  }
  if (stream === "lifecycle") {
    if (phase === "start") return "provider 开始执行";
    if (phase === "end") return "provider 执行完成";
    if (phase === "error") return message || "provider 执行异常";
    return [title || "provider 生命周期", message].filter(Boolean).join(" · ");
  }
  if (stream === "assistant") return message ? `正在生成回复 · ${message}` : "正在生成回复";
  if (stream === "thinking") return message ? `思考中 · ${message}` : "思考中";
  if (stream === "plan") return title ? `更新计划 · ${title}` : "更新计划";
  if (stream === "tool" || stream === "item") {
    return [title || "正在调用工具", trace.status || message].filter(Boolean).join(" · ");
  }
  if (stream === "command_output") return [title || "命令执行中", message].filter(Boolean).join(" · ");
  if (stream === "approval") return [title || "等待审批", trace.status || message].filter(Boolean).join(" · ");
  if (stream === "error") return message || title || "provider 内部错误";
  return [title || stream, message].filter(Boolean).join(" · ");
}
