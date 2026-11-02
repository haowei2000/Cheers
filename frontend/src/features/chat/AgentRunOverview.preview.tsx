import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/ui/theme";
import { ContextActionsProvider } from "@/components/ui/context-actions";
import { PresentationProvider } from "@/components/ui/presentation";
import type { Message, TraceEvent } from "@/types";
import { MessageItem } from "./MessageItem";
import "@/index.css";

function trace(msgId: string, phase: string, status: string, seq: number, tool?: string): TraceEvent {
  return { v: 1, id: `${msgId}-${seq}`, msg_id: msgId, trace_seq: seq, kind: "trace", phase, status,
    tool_call_id: tool, is_terminal: true, created_at: "2026-10-29T00:00:00Z" };
}
const cases = ["completed", "failed", "cancelled", "refused", "truncated", "max_turn_requests", "running", "approval", "unknown"];
createRoot(document.getElementById("root")!).render(
  <ThemeProvider><ContextActionsProvider><main className="min-h-screen bg-canvas p-4 text-content-primary">
    {cases.map(status => {
      const message: Message = {
        msg_id: status, sender_id: "preview-bot", sender_type: "bot", sender_name: "Preview",
        content: `Run outcome: ${status}`, trace_has_failure: status === "completed",
        _streaming: status === "running" || status === "approval",
        _trace_events: status === "unknown" ? [] : [
          trace(status, "tool_call", "failed", 1, "tool-a"),
          trace(status, "tool_call", "completed", 2, "tool-b"),
          ...(["running", "approval"].includes(status) ? [] : [trace(status, status === "failed" ? "prompt_failed" : "prompt_finished", status, 3)]),
        ],
        trace_count: status === "unknown" ? 4 : 3,
      };
      return <section key={status} aria-label={status} className="mb-4">
        <MessageItem message={message} pendingApprovals={status === "approval" ? [{ msg_id: "approval", sender_id: "bot", sender_type: "bot", msg_type: "permission", content: "Approval", content_data: { resolved: false } }] : []} />
      </section>;
    })}
    <section aria-label="Minimal presentation"><PresentationProvider level="minimal">
      <MessageItem message={{ msg_id: "minimal", sender_id: "preview-bot", sender_type: "bot", content: "Completed in minimal presentation", _trace_events: [trace("minimal", "prompt_finished", "completed", 1)] }} />
    </PresentationProvider></section>
  </main></ContextActionsProvider></ThemeProvider>,
);
