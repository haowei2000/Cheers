import type { AgentBridgeTaskContentData, Message } from "../types";

export const AGENT_BRIDGE_TASK_KIND = "agent_bridge_background_task";

export type AgentBridgeTaskMessage = Message & {
  content_data: AgentBridgeTaskContentData;
};
