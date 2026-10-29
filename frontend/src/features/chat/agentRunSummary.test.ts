import { describe, expect, it } from "vitest";
import type { Message, TraceEvent } from "@/types";
import { agentRunSummary } from "./agentRunSummary";

const message: Message = { msg_id: "run", sender_id: "bot", sender_type: "bot", content: "Done" };
function event(phase: string, status: string, seq: number, tool?: string): TraceEvent {
  return { v: 1, id: `event-${seq}`, msg_id: "run", trace_seq: seq, kind: "trace", phase, status,
    tool_call_id: tool, is_terminal: true, created_at: "2026-10-29T00:00:00Z" };
}

describe("agent run overview", () => {
  it("keeps a successful final outcome when an earlier tool failed", () => {
    const result = agentRunSummary({ ...message, trace_has_failure: true, _trace_events: [
      event("tool_call", "failed", 1, "tool-a"),
      event("tool_call", "completed", 2, "tool-b"),
      event("prompt_finished", "completed", 3),
    ] });
    expect(result).toMatchObject({ status: "completed", label: "Completed", tools: 2, failedTools: 1, tone: "warning" });
    expect(result.detail).toBe("2 tools · 1 tool failed");
  });

  it("coalesces tool progress updates and live/durable duplicates", () => {
    const start = event("tool_call", "in_progress", 1, "tool-a");
    const done = event("tool_call_update", "completed", 2, "tool-a");
    const finish = event("prompt_finished", "completed", 3);
    const result = agentRunSummary({ ...message, _trace_events: [done, finish] }, [start, done, finish]);
    expect(result).toMatchObject({ status: "completed", tools: 1, failedTools: 0 });
    expect(result.detail).toBe("1 tool");
  });

  it.each(["cancelled", "refused", "truncated", "max_turn_requests", "failed"])("preserves the final %s outcome", status => {
    expect(agentRunSummary(message, [event("prompt_finished", status, 1)]).status).toBe(status);
  });

  it("only treats a prompt failure as a failed run", () => {
    expect(agentRunSummary(message, [event("prompt_failed", "error", 1)])).toMatchObject({ status: "failed", tone: "danger" });
    expect(agentRunSummary(message, [event("tool_call", "failed", 1, "tool-a")]).status).toBe("unknown");
  });

  it("keeps delivery errors separate from the prompt outcome", () => {
    const result = agentRunSummary(message, [event("terminal_ack_failed", "error", 1), event("prompt_finished", "completed", 2)]);
    expect(result.status).toBe("completed");
    expect(result.detail).toContain("Delivery issue recorded");
  });

  it("does not infer success from a finished message or a historic failure flag", () => {
    expect(agentRunSummary({ ...message, trace_count: 50, trace_has_failure: true })).toMatchObject({
      status: "unknown", label: "Outcome unavailable", detail: "Step errors recorded",
    });
  });

  it("does not present capped trace counts as a complete tool count", () => {
    const result = agentRunSummary({ ...message, trace_count: 600, trace_has_failure: true }, [
      event("tool_call", "failed", 1, "tool-a"), event("prompt_finished", "completed", 2),
    ]);
    expect(result.detail).toBe("Step errors recorded");
  });

  it("shows running and approval states without promoting tool failures", () => {
    const active = { ...message, _streaming: true, _trace_events: [event("tool_call", "failed", 1, "tool-a")] };
    expect(agentRunSummary(active).status).toBe("running");
    expect(agentRunSummary(active, [], 1).status).toBe("approval");
    expect(agentRunSummary(message, [], 1).status).toBe("approval");
  });

  it("retains error history when the same tool later completes", () => {
    const result = agentRunSummary(message, [
      event("tool_call", "failed", 1, "tool-a"),
      event("tool_call_update", "completed", 2, "tool-a"),
      event("prompt_finished", "completed", 3),
    ]);
    expect(result).toMatchObject({ status: "completed", tools: 1, failedTools: 0 });
    expect(result.detail).toBe("1 tool · Step errors recorded");
  });

  it("uses lifecycle order rather than the worst event in the run", () => {
    expect(agentRunSummary(message, [event("prompt_finished", "completed", 3), event("prompt_failed", "error", 1)]).status).toBe("completed");
  });
});
