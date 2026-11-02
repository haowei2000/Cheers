import type { Message, TraceEvent } from "@/types";
import { coalesceTraceEvents } from "./traceEvent";

export type AgentRunStatus = "running" | "approval" | "completed" | "failed" | "cancelled" | "refused" | "truncated" | "max_turn_requests" | "unknown";

const LABELS: Record<AgentRunStatus, string> = {
  running: "Running",
  approval: "Awaiting approval",
  completed: "Completed",
  failed: "Run failed",
  cancelled: "Cancelled",
  refused: "Declined",
  truncated: "Token limit reached",
  max_turn_requests: "Request limit reached",
  unknown: "Outcome unavailable",
};

/** Tool failures are history; only prompt lifecycle events describe the run outcome. */
export function agentRunSummary(message: Message, persisted: TraceEvent[] = [], approvalCount = 0) {
  const live = message._trace_events ?? [];
  const events = coalesceTraceEvents(persisted, live);
  const lifecycle = events.filter(event => ["prompt_started", "prompt_finished", "prompt_failed"].includes(event.phase));
  const latest = lifecycle.at(-1);
  let status: AgentRunStatus = "unknown";
  if (latest?.phase === "prompt_failed" || message.error) status = "failed";
  else if (latest?.phase === "prompt_finished") {
    const terminal = latest.status;
    if (terminal && ["completed", "cancelled", "refused", "truncated", "max_turn_requests", "failed"].includes(terminal)) {
      status = terminal as AgentRunStatus;
    }
  } else if (approvalCount > 0) status = "approval";
  else if (message._streaming || message.is_partial) status = "running";
  const tools = events.filter(event => event.phase === "tool_call" || event.phase === "tool_call_update");
  const failedTools = tools.filter(event => event.status === "failed" || event.status === "error").length;
  const hasStepErrors = Boolean(message.trace_has_failure || [...persisted, ...live].some(event => event.status === "failed" || event.status === "error"));
  const deliveryIssue = events.some(event => event.phase === "terminal_ack_failed");
  // REST trace reads are capped. Never present partial counts as a complete overview.
  const recordedIds = new Set([...persisted, ...live].map(event => event.event_id ?? event.id));
  const countsComplete = recordedIds.size >= (message.trace_count ?? 0);
  const detail = [
    countsComplete && tools.length > 0 ? `${tools.length} tool${tools.length === 1 ? "" : "s"}` : "",
    countsComplete && failedTools > 0 ? `${failedTools} tool${failedTools === 1 ? "" : "s"} failed` : hasStepErrors && status !== "failed" ? "Step errors recorded" : "",
    deliveryIssue ? "Delivery issue recorded" : "",
  ].filter(Boolean).join(" · ");
  const tone = status === "failed" ? "danger" : status === "approval" || hasStepErrors || ["refused", "truncated", "max_turn_requests"].includes(status) ? "warning" : "neutral";
  return { status, label: LABELS[status], detail, tone, tools: tools.length, failedTools };
}
