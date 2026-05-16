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
    placeholder: "Create bot reply placeholder",
    message_stream: "Received streaming chunk",
    message_done: "Streaming reply completed",
    message_done_partial: "Streaming reply interrupted",
    message_done_error: "Streaming reply failed",
  };
  return [labels[phase] || trace.title || "Streaming event", trace.message]
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
      received: "Plugin received the message",
      hydrating_attachments: "Reading attachments",
      attachments_ready: "Attachments are ready",
      loopback_start: "Starting provider",
      loopback_accepted: "Provider accepted the task",
      loopback_error: "Provider routing error",
      subagent_run_started: "Provider run started",
      subagent_run_error: "Provider run failed to start",
    };
    return [labels[phase] || title || "Plugin processing", message].filter(Boolean).join(" · ");
  }
  if (stream === "lifecycle") {
    if (phase === "start") return "Provider started";
    if (phase === "end") return "Provider completed";
    if (phase === "error") return message || "Provider execution error";
    return [title || "Provider lifecycle", message].filter(Boolean).join(" · ");
  }
  if (stream === "assistant") return message ? `Generating reply · ${message}` : "Generating reply";
  if (stream === "thinking") return message ? `Thinking · ${message}` : "Thinking";
  if (stream === "plan") return title ? `Updating plan · ${title}` : "Updating plan";
  if (stream === "tool" || stream === "item") {
    return [title || "Calling tool", trace.status || message].filter(Boolean).join(" · ");
  }
  if (stream === "command_output") return [title || "Command running", message].filter(Boolean).join(" · ");
  if (stream === "approval") return [title || "Waiting for approval", trace.status || message].filter(Boolean).join(" · ");
  if (stream === "error") return message || title || "Provider internal error";
  return [title || stream, message].filter(Boolean).join(" · ");
}
