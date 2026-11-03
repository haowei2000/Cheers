import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/ui/theme";
import { ContextActionsProvider } from "@/components/ui/context-actions";
import { PresentationProvider } from "@/components/ui/presentation";
import type { Message, TraceEvent } from "@/types";
import { MessageItem } from "./MessageItem";
import "@/index.css";

function trace(msgId: string, phase: string, status: string, seq: number, tool?: string): TraceEvent {
  return { v: 1, id: `${msgId}-${seq}`, msg_id: msgId, trace_seq: seq, kind: "trace", phase, status,
    tool_call_id: tool, is_terminal: status !== "in_progress", created_at: "2026-10-29T00:00:00Z" };
}
const command = "pnpm typecheck && pnpm exec vitest run src/components/ui/control-geometry.test.tsx src/features/chat/MessageItem.test.tsx";
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
          { ...trace(status, "tool_call", status === "running" ? "in_progress" : "completed", 2, "tool-b"),
            title: command, data: { presentation: { v: 2, event_type: "shell_command", family: "shell", operation: "run", confidence: "explicit", matched_by: "preview", command } } },
          ...(["running", "approval"].includes(status) ? [] : [trace(status, status === "failed" ? "prompt_failed" : "prompt_finished", status, 3)]),
        ],
        trace_count: status === "unknown" ? 4 : ["running", "approval"].includes(status) ? 2 : 3,
      };
      return <section key={status} aria-label={status} className="mb-4">
        <MessageItem channelId="preview-channel" message={message} pendingApprovals={status === "approval" ? [{ msg_id: "approval", sender_id: "bot", sender_type: "bot", msg_type: "permission", content: "Approval", content_data: { request_id: "preview-approval", title: "Review command", tool: { command }, resolved: false } }] : []} />
      </section>;
    })}
    {(["max", "medium", "minimal"] as const).map(level => <section key={level} aria-label={`Thinking ${level}`} className="mb-4">
      <PresentationProvider level={level}>
        <MessageItem channelId="preview-channel" message={{ msg_id: `thinking-${level}`, sender_id: "preview-bot", sender_type: "bot", sender_name: "Preview", content: "", is_partial: true,
          _trace_events: [{ ...trace(`thinking-${level}`, "tool_call", "in_progress", 1, "tool"), title: command }],
        }} />
      </PresentationProvider>
    </section>)}
    <section aria-label="Before first trace" className="mb-4">
      <MessageItem channelId="preview-channel" message={{ msg_id: "waiting", sender_id: "preview-bot", sender_type: "bot", content: "", is_partial: true }} />
    </section>
    <section aria-label="Minimal presentation"><PresentationProvider level="minimal">
      <MessageItem message={{ msg_id: "minimal", sender_id: "preview-bot", sender_type: "bot", content: "Completed in minimal presentation", _trace_events: [trace("minimal", "prompt_finished", "completed", 1)] }} />
    </PresentationProvider></section>
  </main></ContextActionsProvider></ThemeProvider>,
);
