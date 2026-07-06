import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { listWorkspaces, getPersonalWorkspace } from "@/api/workspaces";
import { listChannels, listDms } from "@/api/channels";
import { useChatStore } from "@/stores/chatStore";
import { useIsMobile } from "@/hooks/useIsMobile";
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
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  // Mobile stacked navigation (Telegram-style): the conversation screen is "pushed"
  // over the list by writing `{ chat: true }` into the history entry's state, so the
  // browser/hardware Back button pops back to the list naturally.
  const chatPushed = Boolean((location.state as { chat?: boolean } | null)?.chat);
  // Mobile-only workspace/nav drawer (the desktop rail, slid in from the left).
  const [navOpen, setNavOpen] = useState(false);

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
  // every sidebar. Wrapped in a callback so mobile hardware-Back can re-run it
  // to refresh unread counts on return to the list.
  const refreshChannels = useCallback(() => {
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

  useEffect(() => {
    refreshChannels();
  }, [refreshChannels]);

  // Mobile: picking a channel pushes the conversation screen.
  const openChatScreen = useCallback(() => {
    setNavOpen(false);
    if (!chatPushed) navigate(location.pathname, { state: { chat: true } });
  }, [chatPushed, navigate, location.pathname]);

  // Mobile: header back (or browser Back) returns to the list. Prefer a real history
  // pop so the stack stays clean; fall back to replace when this is the first entry
  // (e.g. the page was reloaded while the conversation was open).
  const closeChatScreen = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(location.pathname, { replace: true });
  }, [navigate, location.pathname]);

  // Mobile: refetch the channel list whenever the conversation screen is popped, to
  // pick up read/unread changes made while chatting. Watching the chatPushed
  // transition covers both back paths — the header back button *and* the
  // browser/hardware back gesture, which pops the history entry without going
  // through closeChatScreen.
  const prevChatPushed = useRef(chatPushed);
  useEffect(() => {
    const wasPushed = prevChatPushed.current;
    prevChatPushed.current = chatPushed;
    if (isMobile && wasPushed && !chatPushed) refreshChannels();
  }, [isMobile, chatPushed, refreshChannels]);

  const selectedWorkspace = workspaces.find(
    (w) => w.workspace_id === selectedWorkspaceId
  );
  const selectedChannel =
    channels.find((c) => c.channel_id === selectedChannelId) ?? null;

  if (isMobile) {
    const showChat = chatPushed && !!selectedChannel;
    return (
      <div className="flex h-full bg-zinc-950 overflow-hidden">
        {showChat ? (
          <main className="flex-1 min-w-0 flex flex-col">
            <ChannelView channel={selectedChannel} onBack={closeChatScreen} />
          </main>
        ) : (
          <>
            <Sidebar
              workspace={selectedWorkspace}
              onOpenNav={() => setNavOpen(true)}
              onChannelSelected={openChatScreen}
            />
            {navOpen && (
              <div className="fixed inset-0 z-50 flex">
                <div
                  className="absolute inset-0 bg-black/60"
                  onClick={() => setNavOpen(false)}
                  aria-hidden
                />
                <div className="relative h-full flex shadow-2xl">
                  <WorkspaceRail onAction={() => setNavOpen(false)} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

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
