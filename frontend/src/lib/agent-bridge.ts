import type { AgentBridgeTaskContentData, Message } from "../types";

export const AGENT_BRIDGE_TASK_KIND = "agent_bridge_background_task";

export type AgentBridgeTaskMessage = Message & {
  content_data: AgentBridgeTaskContentData;
};

export function getActiveAgentBridgeTaskData(
  message: Message,
  isDmSelected: boolean,
): AgentBridgeTaskContentData | null {
  if (isDmSelected) return null;
  const data = message.content_data;
  return data?.kind === AGENT_BRIDGE_TASK_KIND
    ? (data as AgentBridgeTaskContentData)
    : null;
}

export function getAgentBridgeTaskData(
  message: Message,
  isDmSelected: boolean,
): AgentBridgeTaskContentData | null {
  if (isDmSelected) return null;
  const activeTask = getActiveAgentBridgeTaskData(message, isDmSelected);
  if (activeTask) return activeTask;
  if (message._agent_bridge_task) return message._agent_bridge_task;
  if (message._bot_trace?.length) {
    return {
      kind: AGENT_BRIDGE_TASK_KIND,
      status: message._streaming ? "running" : "done",
      title: "Agent Bridge trace",
      message: message._streaming ? "Provider is running." : "Task completed.",
      task_id: message.task_id || null,
    };
  }
  return null;
}
