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
    personalWorkspace,
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

  // Load channels when the workspace changes. DMs are consolidated into the
  // personal workspace (the user's home), so they're fetched only there — team
  // workspaces show just their own channels, and DMs no longer duplicate across
  // every sidebar.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const isPersonal =
      !!personalWorkspace && selectedWorkspaceId === personalWorkspace.workspace_id;
    Promise.all([
      listChannels(selectedWorkspaceId),
      isPersonal ? listDms().catch(() => []) : Promise.resolve([]),
    ])
      .then(([chs, dms]) => setChannels([...chs, ...dms]))
      .catch(() => {});
  }, [selectedWorkspaceId, personalWorkspace, setChannels]);

  const selectedWorkspace = workspaces.find(
    (w) => w.workspace_id === selectedWorkspaceId
  );
  const selectedChannel =
    channels.find((c) => c.channel_id === selectedChannelId) ?? null;

  return (
    <div className="flex h-full bg-zinc-950">
      <WorkspaceRail />
      <Sidebar workspace={selectedWorkspace} />
      <main className="flex-1 min-w-0 flex flex-col">
        <ChannelView channel={selectedChannel} />
      </main>
    </div>
  );
}
