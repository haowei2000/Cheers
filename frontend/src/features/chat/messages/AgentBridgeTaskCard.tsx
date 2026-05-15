import { AppIcon } from "../../../components/icons/AppIcon";
import type { AgentBridgeTaskContentData, Message } from "../../../types";

interface AgentBridgeTaskCardProps {
  message: Message;
  task: AgentBridgeTaskContentData;
  onOpen: (messageId: string) => void;
}

export function AgentBridgeTaskCard({
  message,
  task,
  onOpen,
}: AgentBridgeTaskCardProps) {
  const title =
    typeof task.title === "string" ? task.title : "后台任务进行中";
  const body =
    typeof task.message === "string"
      ? task.message
      : "Agent Bridge 已接收任务，完成后会自动更新这条回复。";
  const taskId =
    typeof task.task_id === "string" ? task.task_id : message.task_id || null;
  const timeout =
    typeof task.timeout_seconds === "number"
      ? Math.round(task.timeout_seconds)
      : null;

  return (
    <button
      type="button"
      onClick={() => onOpen(message.msg_id)}
      className="my-1.5 block w-full max-w-[min(560px,100%)] rounded-md border px-3 py-2 text-left transition-colors hover:bg-[var(--surface-strong)]"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface-soft)",
        color: "var(--fg-1)",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-flex w-5 h-5 items-center justify-center rounded"
          style={{
            background: "var(--accent-muted)",
            color: "var(--accent)",
          }}
        >
          <AppIcon name="file" className="w-3.5 h-3.5" />
        </span>
        <span className="text-[13px] font-semibold">{title}</span>
        <span
          className="inline-flex items-center gap-1 text-[11px]"
          style={{ color: "var(--fg-3)" }}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ background: "var(--accent)" }}
          />
          running
        </span>
      </div>
      <div
        className="mt-1 text-[12px] leading-relaxed"
        style={{ color: "var(--fg-2)" }}
      >
        {body}
      </div>
      <div
        className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]"
        style={{ color: "var(--fg-3)" }}
      >
        {timeout !== null && <span>等待超过 {timeout}s</span>}
        {taskId && <span>task {taskId.slice(0, 8)}</span>}
      </div>
    </button>
  );
}
