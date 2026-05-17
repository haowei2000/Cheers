import { lazy, Suspense } from "react";
import type { Dispatch, SetStateAction } from "react";
import NotificationPanel from "../../NotificationPanel";
import { LoginModal } from "../LoginModal";
import { CreateWorkspaceModal } from "../CreateWorkspaceModal";
import { InviteWorkspaceMemberModal } from "../InviteWorkspaceMemberModal";
import { CreateChannelModal } from "../CreateChannelModal";
import { OpenClawQcModal } from "../OpenClawQcModal";
import { ChannelSettingsModal } from "../ChannelSettingsModal";
import { HelpModal } from "../HelpModal";
import type {
  BotItem,
  BotTraceEvent,
  Channel,
  ChannelBot,
  CurrentUser,
  MemoryLoadDetail,
  Message,
  Workspace,
} from "../../types";
import { AddBotModal } from "./AddBotModal";
import { MessageDetailModal } from "./MessageDetailModal";

const SettingsModal = lazy(() =>
  import("../SettingsModal").then((module) => ({
    default: module.SettingsModal,
  })),
);

interface AppModalsProps {
  loginModalOpen: boolean;
  currentUser: CurrentUser;
  onCloseLogin: () => void;
  onLoginSuccess: (user: Exclude<CurrentUser, null>, token: string) => void;
  selectedDetailMessage: Message | null;
  selectedMemoryLoadDetail: MemoryLoadDetail | null;
  selectedBotTraceEvents: BotTraceEvent[];
  onCloseMessageDetail: () => void;
  helpOpen: boolean;
  onCloseHelp: () => void;
  apiDocsUrl: string;
  userDocsUrl: string;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  isDark: boolean;
  setTheme: (theme: "light" | "dark") => void;
  authToken: string | null;
  onProfileUpdated: (data: {
    display_name: string;
    bio?: string | null;
    avatar_url?: string | null;
  }) => void;
  onOpenDM: (memberId: string, memberType: "user" | "bot") => void;
  onLogout: () => void;
  qcOpen: boolean;
  onCloseQc: () => void;
  selectedId: string | null;
  selectedChannel: Channel | null;
  createWsOpen: boolean;
  newWorkspaceName: string;
  setNewWorkspaceName: (value: string) => void;
  newWorkspaceAvatarUrl: string;
  setNewWorkspaceAvatarUrl: (value: string) => void;
  onCreateWorkspace: () => void;
  onCloseCreateWorkspace: () => void;
  inviteWsMemberOpen: boolean;
  inviteWsIdentifier: string;
  selectedWorkspaceId: string;
  setInviteWsIdentifier: (value: string) => void;
  onInviteWorkspaceMember: () => void;
  onPickWorkspaceUser: (identifier: string) => void;
  onCloseInviteWorkspaceMember: () => void;
  createChannelOpen: boolean;
  workspaces: Workspace[];
  setSelectedWorkspaceId: Dispatch<SetStateAction<string>>;
  newChannelName: string;
  setNewChannelName: (value: string) => void;
  onCreateChannel: () => void;
  onCloseCreateChannel: () => void;
  addBotOpen: boolean;
  channelBots: ChannelBot[];
  allBots: BotItem[];
  selectedBotIds: Set<string>;
  setSelectedBotIds: Dispatch<SetStateAction<Set<string>>>;
  addingBots: boolean;
  setAddingBots: Dispatch<SetStateAction<boolean>>;
  onCloseAddBot: () => void;
  onRemoveBot: (memberId: string) => void;
  onAddBotToChannel: (botId: string) => Promise<void>;
  notifPanelOpen: boolean;
  onCloseNotifications: () => void;
  onNotificationNavigate: (channelId: string, msgId?: string) => void;
  channelSettingsOpen: boolean;
  currentUserId: string;
  onCloseChannelSettings: () => void;
  setChannels: Dispatch<SetStateAction<Channel[]>>;
  setAutoAssist: Dispatch<SetStateAction<boolean>>;
}

export function AppModals({
  loginModalOpen,
  currentUser,
  onCloseLogin,
  onLoginSuccess,
  selectedDetailMessage,
  selectedMemoryLoadDetail,
  selectedBotTraceEvents,
  onCloseMessageDetail,
  helpOpen,
  onCloseHelp,
  apiDocsUrl,
  userDocsUrl,
  settingsOpen,
  onCloseSettings,
  isDark,
  setTheme,
  authToken,
  onProfileUpdated,
  onOpenDM,
  onLogout,
  qcOpen,
  onCloseQc,
  selectedId,
  selectedChannel,
  createWsOpen,
  newWorkspaceName,
  setNewWorkspaceName,
  newWorkspaceAvatarUrl,
  setNewWorkspaceAvatarUrl,
  onCreateWorkspace,
  onCloseCreateWorkspace,
  inviteWsMemberOpen,
  inviteWsIdentifier,
  selectedWorkspaceId,
  setInviteWsIdentifier,
  onInviteWorkspaceMember,
  onPickWorkspaceUser,
  onCloseInviteWorkspaceMember,
  createChannelOpen,
  workspaces,
  setSelectedWorkspaceId,
  newChannelName,
  setNewChannelName,
  onCreateChannel,
  onCloseCreateChannel,
  addBotOpen,
  channelBots,
  allBots,
  selectedBotIds,
  setSelectedBotIds,
  addingBots,
  setAddingBots,
  onCloseAddBot,
  onRemoveBot,
  onAddBotToChannel,
  notifPanelOpen,
  onCloseNotifications,
  onNotificationNavigate,
  channelSettingsOpen,
  currentUserId,
  onCloseChannelSettings,
  setChannels,
  setAutoAssist,
}: AppModalsProps) {
  return (
    <>
      <LoginModal
        open={loginModalOpen}
        currentUser={currentUser}
        onClose={onCloseLogin}
        onSuccess={onLoginSuccess}
      />

      <MessageDetailModal
        message={selectedDetailMessage}
        memoryLoadDetail={selectedMemoryLoadDetail}
        botTraceEvents={selectedBotTraceEvents}
        onClose={onCloseMessageDetail}
      />

      <HelpModal
        open={helpOpen}
        onClose={onCloseHelp}
        apiDocsUrl={apiDocsUrl}
        userDocsUrl={userDocsUrl}
      />

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onClose={onCloseSettings}
            isDark={isDark}
            setTheme={setTheme}
            authToken={authToken}
            currentUser={currentUser}
            onProfileUpdated={onProfileUpdated}
            onOpenDM={onOpenDM}
            onLogout={onLogout}
          />
        </Suspense>
      )}

      <OpenClawQcModal
        open={qcOpen}
        onClose={onCloseQc}
        channelId={selectedId}
        channelName={selectedChannel?.name}
      />

      <CreateWorkspaceModal
        open={createWsOpen}
        value={newWorkspaceName}
        onChange={setNewWorkspaceName}
        avatarUrl={newWorkspaceAvatarUrl}
        onAvatarUrlChange={setNewWorkspaceAvatarUrl}
        onSubmit={onCreateWorkspace}
        onClose={onCloseCreateWorkspace}
      />

      <InviteWorkspaceMemberModal
        open={inviteWsMemberOpen}
        value={inviteWsIdentifier}
        authToken={authToken}
        workspaceId={selectedWorkspaceId}
        onChange={setInviteWsIdentifier}
        onSubmit={onInviteWorkspaceMember}
        onPickUser={onPickWorkspaceUser}
        onClose={onCloseInviteWorkspaceMember}
      />

      <CreateChannelModal
        open={createChannelOpen}
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={setSelectedWorkspaceId}
        channelName={newChannelName}
        onChannelNameChange={setNewChannelName}
        onSubmit={onCreateChannel}
        onClose={onCloseCreateChannel}
      />

      <AddBotModal
        open={addBotOpen}
        selectedChannelId={selectedId}
        channelBots={channelBots}
        allBots={allBots}
        selectedBotIds={selectedBotIds}
        addingBots={addingBots}
        onClose={onCloseAddBot}
        onRemoveBot={onRemoveBot}
        onToggleBot={(botId) =>
          setSelectedBotIds((prev) => {
            const next = new Set(prev);
            if (next.has(botId)) next.delete(botId);
            else next.add(botId);
            return next;
          })
        }
        onAddSelected={async () => {
          setAddingBots(true);
          try {
            await Promise.all(
              [...selectedBotIds].map((id) => onAddBotToChannel(id)),
            );
            setSelectedBotIds(new Set());
          } finally {
            setAddingBots(false);
          }
        }}
      />

      <NotificationPanel
        isOpen={notifPanelOpen}
        onClose={onCloseNotifications}
        userToken={authToken ?? undefined}
        onNavigate={onNotificationNavigate}
      />

      {selectedId && (
        <ChannelSettingsModal
          open={channelSettingsOpen}
          channel={selectedChannel}
          currentUserId={currentUserId}
          userToken={authToken}
          onClose={onCloseChannelSettings}
          onSaved={(updated) => {
            setChannels((prev) =>
              prev.map((channel) =>
                channel.channel_id === updated.channel_id
                  ? { ...channel, ...updated }
                  : channel,
              ),
            );
            setAutoAssist(Boolean(updated.auto_assist));
          }}
        />
      )}
    </>
  );
}
