import { useEffect } from "react";
import { listWorkspaces } from "@/api/workspaces";
import { listChannels } from "@/api/channels";
import { useChatStore } from "@/stores/chatStore";
import { WorkspaceRail } from "./WorkspaceRail";
import { Sidebar } from "./Sidebar";
import { ChannelView } from "./ChannelView";

export default function ChatLayout() {
  const {
    workspaces,
    channels,
    selectedWorkspaceId,
    selectedChannelId,
    setWorkspaces,
    setChannels,
    selectWorkspace,
  } = useChatStore();

  // Load workspaces on mount
  useEffect(() => {
    listWorkspaces()
      .then((ws) => {
        setWorkspaces(ws);
        if (ws.length > 0 && !selectedWorkspaceId) {
          selectWorkspace(ws[0].workspace_id);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load channels when workspace changes
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    listChannels(selectedWorkspaceId)
      .then((chs) => setChannels(chs))
      .catch(() => {});
  }, [selectedWorkspaceId, setChannels]);

  const selectedWorkspace = workspaces.find(
    (w) => w.workspace_id === selectedWorkspaceId
  );
  const selectedChannel =
    channels.find((c) => c.channel_id === selectedChannelId) ?? null;

  return (
    <div className="flex h-full bg-zinc-950">
      <WorkspaceRail />
      <Sidebar workspaceName={selectedWorkspace?.name} />
      <main className="flex-1 min-w-0 flex flex-col">
        <ChannelView channel={selectedChannel} />
      </main>
    </div>
  );
}
