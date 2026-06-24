import { useEffect } from "react";
import { listWorkspaces, getPersonalWorkspace } from "@/api/workspaces";
import { listChannels, listDms } from "@/api/channels";
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
    setPersonalWorkspace,
    setChannels,
    selectWorkspace,
  } = useChatStore();

  // Load workspaces + the personal workspace on mount. The personal workspace is the
  // user's home (DMs + private space), so it's the default selection.
  useEffect(() => {
    Promise.all([listWorkspaces(), getPersonalWorkspace().catch(() => null)])
      .then(([ws, personal]) => {
        setWorkspaces(ws);
        if (personal) setPersonalWorkspace(personal);
        if (!selectedWorkspaceId) {
          selectWorkspace(personal?.workspace_id ?? ws[0]?.workspace_id ?? null);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load channels when workspace changes. DMs are workspace-agnostic (type='dm' channels,
  // reached by membership), so they're loaded alongside and merged into the same list.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    Promise.all([listChannels(selectedWorkspaceId), listDms().catch(() => [])])
      .then(([chs, dms]) => setChannels([...chs, ...dms]))
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
