import type { MemoryTab } from "../components/ChannelHeader";

export const MEMORY_TAB_VALUES: MemoryTab[] = ["PROJECT", "FILES_INDEX", "MEMBERS", "TODO"];

export type ChatRouteParams = {
  workspaceId?: string;
  channelId?: string;
};

export type ChatUrlState = {
  topicId: string | null;
  taskOpen: boolean;
  taskMsgId: string | null;
  memoryTab: MemoryTab | null;
};

export function isMemoryTab(value: string | null): value is MemoryTab {
  return Boolean(value && MEMORY_TAB_VALUES.includes(value as MemoryTab));
}

export function readChatUrlState(search: string, hash: string): ChatUrlState {
  const params = new URLSearchParams(search);
  const topicFromSearch = params.get("topic");
  const topicFromHash = /#topic=([^&]+)/.exec(hash || "")?.[1];
  const topicId = topicFromSearch || (topicFromHash ? decodeURIComponent(topicFromHash) : null);
  const view = params.get("view");
  const panel = params.get("panel");

  return {
    topicId,
    taskOpen: !topicId && view === "tasks",
    taskMsgId: params.get("task"),
    memoryTab: isMemoryTab(panel) ? panel : null,
  };
}

export function buildChatPath(workspaceId: string, channelId: string | null): string {
  if (!workspaceId) return "/";
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  if (!channelId) return `/workspaces/${encodedWorkspaceId}`;
  return `/workspaces/${encodedWorkspaceId}/channels/${encodeURIComponent(channelId)}`;
}

export function buildChatSearch(state: ChatUrlState): string {
  const params = new URLSearchParams();
  if (state.topicId) {
    params.set("topic", state.topicId);
  } else if (state.taskOpen) {
    params.set("view", "tasks");
    if (state.taskMsgId) params.set("task", state.taskMsgId);
  }
  if (state.memoryTab) params.set("panel", state.memoryTab);
  return params.toString();
}
