import type { BotTraceEvent, Message } from "../types";

const CLIENT_STREAM_TRACE = "agentnexus_client";
const MAX_BOT_TRACE_EVENTS = 160;
const MERGED_PREVIEW_LIMIT = 600;
const TRACE_ARRAY_KEYS = ["bot_trace", "agent_bridge_trace", "trace_events"];

export function trimBotTraceEvents(events: BotTraceEvent[]): BotTraceEvent[] {
  return events.slice(-MAX_BOT_TRACE_EVENTS);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTraceEvent(value: unknown, message: Message): BotTraceEvent | null {
  if (!isObject(value)) return null;
  return {
    ...(value as Record<string, unknown>),
    msg_id: typeof value.msg_id === "string" ? value.msg_id : message.msg_id,
    task_id:
      typeof value.task_id === "string" || value.task_id === null
        ? value.task_id
        : message.task_id || null,
    bot_id:
      typeof value.bot_id === "string" ? value.bot_id : message.sender_id,
    channel_id:
      typeof value.channel_id === "string" ? value.channel_id : undefined,
    stream: typeof value.stream === "string" ? value.stream : undefined,
    seq: typeof value.seq === "number" ? value.seq : undefined,
    ts: typeof value.ts === "number" ? value.ts : undefined,
    phase: typeof value.phase === "string" ? value.phase : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
    data: isObject(value.data) ? value.data : undefined,
  } as BotTraceEvent;
}

function traceDedupeKey(trace: BotTraceEvent, index: number): string {
  const hasStableSeq =
    trace.seq !== undefined &&
    (trace.stream || trace.phase || trace.run_id || trace.task_id);
  if (hasStableSeq) {
    return [
      trace.bot_id || "",
      trace.task_id || "",
      trace.run_id || "",
      trace.stream || "",
      trace.phase || "",
      trace.seq,
    ].join(":");
  }
  return [
    trace.bot_id || "",
    trace.task_id || "",
    trace.stream || "",
    trace.phase || "",
    trace.title || "",
    trace.message || "",
    trace.ts || index,
  ].join(":");
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncateMergedPreview(value: string): string {
  if (value.length <= MERGED_PREVIEW_LIMIT) return value;
  return `${value.slice(0, MERGED_PREVIEW_LIMIT)}...`;
}

function sameTraceBatch(a: BotTraceEvent, b: BotTraceEvent): boolean {
  return (
    a.msg_id === b.msg_id &&
    (a.task_id || "") === (b.task_id || "") &&
    (a.bot_id || "") === (b.bot_id || "") &&
    (a.run_id || "") === (b.run_id || "") &&
    (a.stream || "") === (b.stream || "") &&
    (a.phase || "") === (b.phase || "")
  );
}

function isTokenChunkTrace(trace: BotTraceEvent): boolean {
  return trace.stream === CLIENT_STREAM_TRACE && trace.phase === "message_stream";
}

function isThinkingChunkTrace(trace: BotTraceEvent): boolean {
  return trace.phase === "agent_thought_chunk" || trace.stream === "thinking";
}

function canCoalesceTrace(a: BotTraceEvent, b: BotTraceEvent): boolean {
  if (!sameTraceBatch(a, b)) return false;
  return (
    (isTokenChunkTrace(a) && isTokenChunkTrace(b)) ||
    (isThinkingChunkTrace(a) && isThinkingChunkTrace(b))
  );
}

function mergeTokenChunkTrace(a: BotTraceEvent, b: BotTraceEvent): BotTraceEvent {
  const aData = isObject(a.data) ? a.data : {};
  const bData = isObject(b.data) ? b.data : {};
  const chars =
    numericValue(aData.delta_chars) + numericValue(bData.delta_chars);
  const chunks =
    Math.max(1, numericValue(aData.coalesced_chunks)) +
    Math.max(1, numericValue(bData.coalesced_chunks));
  const preview = truncateMergedPreview(
    stringValue(aData.delta_preview) + stringValue(bData.delta_preview),
  );
  return {
    ...a,
    seq: b.seq ?? a.seq,
    ts: b.ts ?? a.ts,
    status: b.status ?? a.status,
    title: b.title ?? a.title,
    message: `+${chars} chars / ${chunks} chunks`,
    data: {
      ...aData,
      ...bData,
      delta_chars: chars,
      delta_preview: preview,
      accumulated_chars:
        numericValue(bData.accumulated_chars) ||
        numericValue(aData.accumulated_chars),
      coalesced_chunks: chunks,
    },
  };
}

function mergeThinkingChunkTrace(a: BotTraceEvent, b: BotTraceEvent): BotTraceEvent {
  const aData = isObject(a.data) ? a.data : {};
  const bData = isObject(b.data) ? b.data : {};
  const message = truncateMergedPreview(
    `${a.message || ""}${b.message || ""}`,
  );
  return {
    ...a,
    seq: b.seq ?? a.seq,
    ts: b.ts ?? a.ts,
    status: b.status ?? a.status,
    title: b.title ?? a.title,
    message,
    data: {
      ...aData,
      ...bData,
      coalesced_chunks:
        Math.max(1, numericValue(aData.coalesced_chunks)) +
        Math.max(1, numericValue(bData.coalesced_chunks)),
      thought_preview: message,
    },
  };
}

function mergeTraceEvents(a: BotTraceEvent, b: BotTraceEvent): BotTraceEvent {
  if (isTokenChunkTrace(a) && isTokenChunkTrace(b)) {
    return mergeTokenChunkTrace(a, b);
  }
  if (isThinkingChunkTrace(a) && isThinkingChunkTrace(b)) {
    return mergeThinkingChunkTrace(a, b);
  }
  return b;
}

export function coalesceBotTraceEvents(events: BotTraceEvent[]): BotTraceEvent[] {
  const merged: BotTraceEvent[] = [];
  for (const event of events) {
    const previous = merged[merged.length - 1];
    if (previous && canCoalesceTrace(previous, event)) {
      merged[merged.length - 1] = mergeTraceEvents(previous, event);
    } else {
      merged.push(event);
    }
  }
  return merged;
}

export function appendBotTraceEvent(
  events: BotTraceEvent[],
  event: BotTraceEvent,
): BotTraceEvent[] {
  return trimBotTraceEvents(coalesceBotTraceEvents([...events, event]));
}

export function persistedBotTraceEvents(message: Message): BotTraceEvent[] {
  const contentData = message.content_data;
  if (!contentData || typeof contentData !== "object") return [];
  const events: BotTraceEvent[] = [];
  for (const key of TRACE_ARRAY_KEYS) {
    const value = contentData[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const event = normalizeTraceEvent(item, message);
      if (event) events.push(event);
    }
  }
  return trimBotTraceEvents(coalesceBotTraceEvents(events));
}

export function messageBotTraceEvents(message: Message): BotTraceEvent[] {
  const events: BotTraceEvent[] = [];
  const seen = new Set<string>();
  const append = (items: BotTraceEvent[]) => {
    for (const item of items) {
      const normalized = normalizeTraceEvent(item, message);
      if (!normalized) continue;
      const key = traceDedupeKey(normalized, events.length);
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = events[events.length - 1];
      if (previous && canCoalesceTrace(previous, normalized)) {
        events[events.length - 1] = mergeTraceEvents(previous, normalized);
      } else {
        events.push(normalized);
      }
    }
  };
  append(message._bot_trace || []);
  append(persistedBotTraceEvents(message));
  return trimBotTraceEvents(events);
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
