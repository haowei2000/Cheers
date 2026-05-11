import {
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  ClipboardDocumentListIcon,
} from "@heroicons/react/24/outline";
import type { BotTraceEvent, Channel, ChannelBot, Message, AgentBridgeTaskContentData } from "../types";
import { formatTs } from "../lib/message";
import { SessionScopePanel } from "./SessionScopePanel";

type TaskMessage = Message & {
  content_data: AgentBridgeTaskContentData;
};

interface TaskPageProps {
  tasks: TaskMessage[];
  selectedMsgId: string | null;
  channel: Channel | null | undefined;
  channelBots: ChannelBot[];
  onSelectTask: (msgId: string) => void;
  onBack: () => void;
  onJumpToMessage: (msgId: string) => void;
}

function taskTitle(task: TaskMessage): string {
  return task.content_data.title || "后台任务进行中";
}

function taskMessage(task: TaskMessage): string {
  return task.content_data.message || task.content || "Agent Bridge 已接收任务，完成后会自动更新这条回复。";
}

function botLabel(task: TaskMessage, channelBots: ChannelBot[]): string {
  const bot = channelBots.find((b) => b.member_id === task.sender_id);
  return task.sender_name || bot?.display_name || bot?.username || "Bot";
}

function traceTitle(trace: BotTraceEvent): string {
  return trace.title || trace.phase || trace.status || trace.stream || "Agent Bridge";
}

export function TaskPage({
  tasks,
  selectedMsgId,
  channel,
  channelBots,
  onSelectTask,
  onBack,
  onJumpToMessage,
}: TaskPageProps) {
  const selected = tasks.find((t) => t.msg_id === selectedMsgId) || tasks[0] || null;
  const traces = selected?._bot_trace || [];
  const selectedTaskId = selected?.content_data.task_id || selected?.task_id || "";
  const selectedBotId = selected?.content_data.bot_id || selected?.sender_id || "";

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: "var(--bg-0)", color: "var(--fg-1)" }}>
      <div className="h-12 flex items-center gap-3 px-4 border-b" style={{ borderColor: "var(--border)" }}>
        <button
          type="button"
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[var(--surface-soft)]"
          title="返回频道"
        >
          <ArrowLeftIcon className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold truncate">
            #{channel?.name || "频道"} Tasks
          </div>
          <div className="text-[11px]" style={{ color: "var(--fg-3)" }}>
            {tasks.length} 个后台任务
          </div>
        </div>
      </div>
      {selected && selectedTaskId && channel?.channel_id && (
        <SessionScopePanel
          scopeType="task"
          scopeId={selectedTaskId}
          channelId={channel.channel_id}
          botId={selectedBotId}
          title="任务对应 Session"
        />
      )}

      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
        <div className="border-r overflow-auto" style={{ borderColor: "var(--border)" }}>
          {tasks.length === 0 ? (
            <div className="p-4 text-sm" style={{ color: "var(--fg-3)" }}>
              当前频道没有后台任务。
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {tasks.map((task) => {
                const active = selected?.msg_id === task.msg_id;
                return (
                  <button
                    key={task.msg_id}
                    type="button"
                    onClick={() => onSelectTask(task.msg_id)}
                    className="w-full text-left rounded-md px-3 py-2 transition-colors"
                    style={{
                      background: active ? "var(--accent-muted)" : "transparent",
                      color: "var(--fg-1)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <ClipboardDocumentListIcon className="w-4 h-4 flex-shrink-0" />
                      <span className="text-[13px] font-medium truncate">{taskTitle(task)}</span>
                    </div>
                    <div className="mt-1 text-[11px] truncate" style={{ color: "var(--fg-3)" }}>
                      {botLabel(task, channelBots)} · {task.created_at ? formatTs(task.created_at) : "刚刚"}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="overflow-auto">
          {!selected ? (
            <div
              className="h-full flex flex-col items-center justify-center gap-2 text-sm"
              style={{ color: "var(--fg-3)" }}
            >
              <ClipboardDocumentListIcon className="w-6 h-6" />
              <span>当前频道没有后台任务。</span>
            </div>
          ) : (
            <div className="max-w-3xl p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <ClipboardDocumentListIcon className="w-5 h-5" style={{ color: "var(--accent)" }} />
                    <h2 className="text-lg font-semibold">{taskTitle(selected)}</h2>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--fg-2)" }}>
                    {taskMessage(selected)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onJumpToMessage(selected.msg_id)}
                  className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-[var(--surface-soft)]"
                  style={{ borderColor: "var(--border)", color: "var(--fg-2)" }}
                >
                  <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                  消息
                </button>
              </div>

              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div className="rounded-md border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-soft)" }}>
                  <div style={{ color: "var(--fg-3)" }}>状态</div>
                  <div className="mt-1 font-medium">{selected.content_data.status || "running"}</div>
                </div>
                <div className="rounded-md border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-soft)" }}>
                  <div style={{ color: "var(--fg-3)" }}>Bot</div>
                  <div className="mt-1 font-medium">{botLabel(selected, channelBots)}</div>
                </div>
                <div className="rounded-md border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-soft)" }}>
                  <div style={{ color: "var(--fg-3)" }}>Task ID</div>
                  <div className="mt-1 font-mono break-all">{selected.content_data.task_id || selected.task_id || "-"}</div>
                </div>
                <div className="rounded-md border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-soft)" }}>
                  <div style={{ color: "var(--fg-3)" }}>转后台阈值</div>
                  <div className="mt-1 font-medium">
                    {typeof selected.content_data.timeout_seconds === "number"
                      ? `${selected.content_data.timeout_seconds}s`
                      : "-"}
                  </div>
                </div>
              </div>

              <div className="mt-5">
                <h3 className="text-sm font-semibold">Agent Bridge 过程</h3>
                {traces.length === 0 ? (
                  <div className="mt-2 rounded-md border p-3 text-sm" style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}>
                    暂无 trace 事件；任务完成后这条消息会自动更新。
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    {traces.map((trace, index) => (
                      <div
                        key={`${trace.seq ?? index}-${trace.title ?? trace.phase ?? "trace"}`}
                        className="rounded-md border p-3"
                        style={{ borderColor: "var(--border)", background: "var(--surface-soft)" }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[13px] font-medium">{traceTitle(trace)}</div>
                          <div className="text-[11px]" style={{ color: "var(--fg-3)" }}>
                            {trace.status || trace.stream || ""}
                          </div>
                        </div>
                        {trace.message && (
                          <div className="mt-1 text-xs leading-relaxed" style={{ color: "var(--fg-2)" }}>
                            {trace.message}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
