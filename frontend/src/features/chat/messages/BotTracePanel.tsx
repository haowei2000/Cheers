import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AppIcon, type AppIconName } from "../../../components/icons/AppIcon";
import {
  botTraceStatusText,
  streamTraceLabel,
  traceTimeLabel,
  userVisibleBotTraceEvents,
} from "../../../lib/bot-trace";
import type { BotTraceEvent, Message } from "../../../types";

type TraceTone = "neutral" | "blue" | "green" | "orange" | "red";

type TraceMeta = {
  icon: AppIconName;
  label: string;
  tone: TraceTone;
};

const TRACE_TEXT_PREVIEW_LIMIT = 600;
const TRACE_RAW_JSON_LIMIT = 12000;

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}... (${value.length - limit} chars truncated)`;
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function eventData(event: BotTraceEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object" ? event.data : {};
}

function traceMeta(event: BotTraceEvent): TraceMeta {
  const stream = event.stream || "";
  const phase = event.phase || "";
  const status = (event.status || "").toLowerCase();
  if (stream === "error" || phase.includes("error") || status.includes("fail")) {
    return { icon: "close", label: "Error", tone: "red" };
  }
  if (phase === "message_done" || phase === "prompt_finished" || status === "completed") {
    return { icon: "checkCircle", label: "Completed", tone: "green" };
  }
  if (phase === "message_stream" || stream === "assistant") {
    return { icon: "message", label: "Streaming", tone: "blue" };
  }
  if (
    phase === "tool_call" ||
    phase === "tool_call_update" ||
    stream === "tool" ||
    stream === "item"
  ) {
    return { icon: "tools", label: "Tool", tone: "orange" };
  }
  if (phase === "file_uploaded" || phase === "file_upload_retry") {
    return { icon: "file", label: "File", tone: phase === "file_uploaded" ? "green" : "orange" };
  }
  if (phase === "agent_thought_chunk" || stream === "thinking") {
    return { icon: "memory", label: "Thinking", tone: "blue" };
  }
  if (phase === "plan" || stream === "plan") {
    return { icon: "task", label: "Plan", tone: "blue" };
  }
  if (phase === "permission_requested" || phase === "permission_resolved" || stream === "approval") {
    return {
      icon: phase === "permission_resolved" ? "checkCircle" : "shieldCheck",
      label: "Approval",
      tone: status === "denied" ? "red" : status === "approved" ? "green" : "orange",
    };
  }
  if (stream === "acp" || phase.startsWith("prompt_")) {
    return { icon: "zap", label: "ACP", tone: status === "cancelled" ? "orange" : "neutral" };
  }
  return { icon: "clock", label: stream || "Event", tone: "neutral" };
}

function eventTitle(event: BotTraceEvent): string {
  const data = eventData(event);
  const phase = event.phase || "";
  if (phase === "tool_call" || phase === "tool_call_update") {
    return valueText(data.title) || event.title || "Tool call";
  }
  if (phase === "file_uploaded") {
    return valueText(data.filename) || event.message || "File uploaded";
  }
  if (phase === "file_upload_retry") {
    return event.title || "Retrying file upload";
  }
  if (phase === "agent_thought_chunk") return event.title || "Agent thought";
  if (phase === "prompt_started") return event.title || "ACP prompt started";
  if (phase === "prompt_finished") return event.title || "ACP prompt finished";
  return event.title || streamTraceLabel(event) || botTraceStatusText(event);
}

function renderPlanEntries(data: Record<string, unknown>): ReactNode {
  const entries = data.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return (
    <ol className="an-trace-plan">
      {entries.slice(0, 8).map((entry, index) => {
        const item =
          entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        const status = valueText(item.status) || "pending";
        const content = valueText(item.content) || valueText(item.title) || `Step ${index + 1}`;
        return (
          <li key={`${status}-${index}`}>
            <span>{status}</span>
            <b>{content}</b>
          </li>
        );
      })}
    </ol>
  );
}

function renderEventBody(event: BotTraceEvent): ReactNode {
  const data = eventData(event);
  const phase = event.phase || "";
  const planEntries = renderPlanEntries(data);
  if (planEntries) return planEntries;

  if (phase === "message_stream") {
    const chars = valueText(data.delta_chars);
    const chunks = valueText(data.coalesced_chunks);
    const preview = truncateText(valueText(data.delta_preview), TRACE_TEXT_PREVIEW_LIMIT);
    return (
      <>
        <div className="an-trace-kv">
          {chars && <span>{chars} chars</span>}
          {chunks && chunks !== "1" && <span>{chunks} chunks</span>}
        </div>
        {preview && <div className="an-trace-preview">{preview}</div>}
      </>
    );
  }

  if (phase === "tool_call" || phase === "tool_call_update") {
    return (
      <div className="an-trace-kv">
        {valueText(data.toolCallId) && <span>id {valueText(data.toolCallId)}</span>}
        {event.status && <span>{event.status}</span>}
      </div>
    );
  }

  if (phase === "file_uploaded" || phase === "file_upload_retry") {
    return (
      <div className="an-trace-kv">
        {valueText(data.content_type) && <span>{valueText(data.content_type)}</span>}
        {valueText(data.size_bytes) && <span>{valueText(data.size_bytes)} bytes</span>}
        {valueText(data.file_id) && <span>file {valueText(data.file_id).slice(0, 8)}</span>}
      </div>
    );
  }

  if (event.message) {
    return (
      <div className="an-trace-preview">
        {truncateText(event.message, TRACE_TEXT_PREVIEW_LIMIT)}
      </div>
    );
  }
  return null;
}

function rawData(event: BotTraceEvent): Record<string, unknown> {
  const data = eventData(event);
  return Object.keys(data).length ? data : {};
}

function eventKey(event: BotTraceEvent, index: number): string {
  return [
    event.stream || "trace",
    event.phase || "event",
    event.run_id || "",
    event.seq ?? index,
    event.ts ?? index,
  ].join(":");
}

function TraceRawData({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const raw = useMemo(() => {
    if (!open) return "";
    const json = JSON.stringify(data, null, 2);
    return truncateText(json, TRACE_RAW_JSON_LIMIT);
  }, [data, open]);

  return (
    <details
      className="an-trace-raw"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Raw event data</summary>
      {open && <pre>{raw}</pre>}
    </details>
  );
}

export function BotTracePanel({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const events = useMemo(() => userVisibleBotTraceEvents(message), [message]);
  if (message.sender_type !== "bot" || events.length === 0) return null;

  const latest = events[events.length - 1];
  const latestMeta = traceMeta(latest);
  const latestLabel = truncateText(
    streamTraceLabel(latest) || botTraceStatusText(latest),
    TRACE_TEXT_PREVIEW_LIMIT,
  );

  return (
    <div className={`an-trace-panel is-${latestMeta.tone}`}>
      <button
        type="button"
        className="an-trace-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="an-trace-toggle-icon">
          <AppIcon name={expanded ? "chevronDown" : "chevronRight"} className="h-3.5 w-3.5" />
        </span>
        <span className="an-trace-kind">
          <AppIcon name={latestMeta.icon} className="h-3.5 w-3.5" />
          {latestMeta.label}
        </span>
        <span className="an-trace-latest">{latestLabel}</span>
        <span className="an-trace-count">{events.length}</span>
      </button>
      {expanded && (
        <div className="an-trace-list">
          {events.map((event, index) => {
            const meta = traceMeta(event);
            const data = rawData(event);
            return (
              <div key={eventKey(event, index)} className={`an-trace-event is-${meta.tone}`}>
                <div className="an-trace-marker">
                  <AppIcon name={meta.icon} className="h-3.5 w-3.5" />
                </div>
                <div className="an-trace-event-body">
                  <div className="an-trace-event-head">
                    <span className="an-trace-event-title">{eventTitle(event)}</span>
                    <span className="an-trace-event-meta">
                      {traceTimeLabel(event.ts) || `#${index + 1}`}
                      {event.stream ? ` · ${event.stream}` : ""}
                      {event.phase ? `/${event.phase}` : ""}
                    </span>
                  </div>
                  {renderEventBody(event)}
                  {Object.keys(data).length > 0 && <TraceRawData data={data} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
