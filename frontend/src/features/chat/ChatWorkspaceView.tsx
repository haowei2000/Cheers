import { useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { AppIcon } from "../../components/icons/AppIcon";
import { ChannelHeader, type MemoryTab } from "../../components/ChannelHeader";
import {
  MessageComposer,
  type MessageComposerProps,
} from "../../components/MessageComposer";
import { SessionScopePanel } from "../../components/SessionScopePanel";
import type { SessionScopeTarget } from "../../components/SessionScopePanel";
import { formatTs, TOPIC_DISPLAY_THRESHOLD } from "../../lib/message";
import type { AgentBridgeTaskMessage } from "../../lib/agent-bridge";
import type { Channel, DM, Message } from "../../types";
import {
  ChatMessageList,
  type ChatMessageListProps,
} from "./messages/ChatMessageList";
import {
  ChatTaskOverlay,
  type ChatTaskOverlayProps,
} from "./overlays/ChatTaskOverlay";
import {
  ChatTopicOverlay,
  type ChatTopicOverlayProps,
} from "./overlays/ChatTopicOverlay";

interface ChatWorkspaceViewProps {
  selectedId: string | null;
  selectedChannel: Channel | null;
  activeDm: DM | null;
  activeBotDm: DM | null;
  activeDmSessionScopeId: string | null;
  dmSessionRefreshNonce: number;
  isMobile: boolean;
  isPersonalWorkspace: boolean;
  isDmSelected: boolean;
  autoAssist: boolean;
  memoryTab: MemoryTab | null;
  topicRoots: Message[];
  topicRepliesOf: (rootId: string) => Message[];
  taskPageOpen: boolean;
  agentBridgeTaskMessages: AgentBridgeTaskMessage[];
  refreshingDmSession: boolean;
  canRefreshSessions: boolean;
  taskOverlayProps: ChatTaskOverlayProps;
  topicOverlayProps: ChatTopicOverlayProps;
  messageListProps: ChatMessageListProps;
  forwardSelectionBar?: ReactNode;
  composerProps: MessageComposerProps;
  setMemoryTab: Dispatch<SetStateAction<MemoryTab | null>>;
  setPageTopicId: Dispatch<SetStateAction<string | null>>;
  setPageTaskMsgId: Dispatch<SetStateAction<string | null>>;
  setTaskPageOpen: Dispatch<SetStateAction<boolean>>;
  onOpenSidebar: () => void;
  onOpenChannelSettings: () => void;
  onJumpToMessage: (msgId: string) => void;
  onRefreshDmSession?: () => void;
}

export function ChatWorkspaceView({
  selectedId,
  selectedChannel,
  activeDm,
  activeBotDm,
  activeDmSessionScopeId,
  dmSessionRefreshNonce,
  isMobile,
  isPersonalWorkspace,
  isDmSelected,
  autoAssist,
  memoryTab,
  topicRoots,
  topicRepliesOf,
  taskPageOpen,
  agentBridgeTaskMessages,
  refreshingDmSession,
  canRefreshSessions,
  taskOverlayProps,
  topicOverlayProps,
  messageListProps,
  forwardSelectionBar,
  composerProps,
  setMemoryTab,
  setPageTopicId,
  setPageTaskMsgId,
  setTaskPageOpen,
  onOpenSidebar,
  onOpenChannelSettings,
  onJumpToMessage,
  onRefreshDmSession,
}: ChatWorkspaceViewProps) {
  const mobileBrandLabel = "AgentNexus";
  const topics = useMemo(
    () =>
      topicRoots
        .map((root) => {
          const replies = topicRepliesOf(root.msg_id);
          const isExplicit = root.msg_type === "topic";
          if (!isExplicit && replies.length < TOPIC_DISPLAY_THRESHOLD) {
            return null;
          }
          const title =
            (root.content || "").replace(/\s+/g, " ").trim().slice(0, 60) ||
            "(No title)";
          const last = replies[replies.length - 1];
          return {
            rootId: root.msg_id,
            title,
            count: replies.length,
            lastTime: last?.created_at ? formatTs(last.created_at) : undefined,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
    [topicRepliesOf, topicRoots],
  );

  const openSessionScopeTarget = (target: SessionScopeTarget) => {
    if (target.scopeType === "topic") {
      setMemoryTab(null);
      setTaskPageOpen(false);
      setPageTaskMsgId(null);
      setPageTopicId(target.scopeId);
      return;
    }

    if (target.scopeType === "task") {
      const task = agentBridgeTaskMessages.find((message) =>
        message.msg_id === target.scopeId ||
        message.task_id === target.scopeId ||
        message.content_data.task_id === target.scopeId,
      );
      if (!task) return;
      setMemoryTab(null);
      setPageTopicId(null);
      setPageTaskMsgId(task.msg_id);
      setTaskPageOpen(true);
      return;
    }

    if (target.scopeType === "channel" || target.scopeType === "dm") {
      setMemoryTab(null);
      setPageTopicId(null);
      setPageTaskMsgId(null);
      setTaskPageOpen(false);
    }
  };

  return (
    <>
      <ChatTaskOverlay {...taskOverlayProps} onOpenSessionScope={openSessionScopeTarget} />
      <ChatTopicOverlay {...topicOverlayProps} onOpenSessionScope={openSessionScopeTarget} />

      {selectedId ? (
        <>
          <ChannelHeader
            channel={selectedChannel}
            activeDm={activeDm}
            isMobile={isMobile}
            onOpenSidebar={onOpenSidebar}
            autoAssist={autoAssist}
            onOpenChannelSettings={onOpenChannelSettings}
            memoryTab={memoryTab}
            onSetMemoryTab={(tab) => {
              setTaskPageOpen(false);
              setPageTaskMsgId(null);
              setMemoryTab(tab);
            }}
            topics={topics}
            onOpenTopic={(rootId) => {
              setTaskPageOpen(false);
              setPageTaskMsgId(null);
              setPageTopicId(rootId);
            }}
            onJumpToMessage={onJumpToMessage}
            taskCount={isDmSelected ? 0 : agentBridgeTaskMessages.length}
            taskActive={!isDmSelected && taskPageOpen}
            onOpenTasks={
              isDmSelected
                ? undefined
                : () => {
                    setMemoryTab(null);
                    setPageTopicId(null);
                    setPageTaskMsgId(agentBridgeTaskMessages[0]?.msg_id ?? null);
                    setTaskPageOpen(true);
                  }
            }
            sessionAction={
              activeBotDm && activeDmSessionScopeId ? (
                <SessionScopePanel
                  scopeType="dm"
                  scopeId={activeDmSessionScopeId}
                  channelId={selectedId}
                  botId={activeBotDm.counterparty.member_id}
                  title="DM sessions"
                  refreshKey={dmSessionRefreshNonce}
                  variant="toolbar"
                  onRefresh={onRefreshDmSession}
                  refreshing={refreshingDmSession}
                  canRefresh={canRefreshSessions}
                  onOpenScope={openSessionScopeTarget}
                />
              ) : (
                selectedChannel?.type !== "dm" && (
                  <SessionScopePanel
                    scopeType="channel"
                    scopeId={selectedId}
                    channelId={selectedId}
                    title="Channel sessions"
                    variant="toolbar"
                    onOpenScope={openSessionScopeTarget}
                  />
                )
              )
            }
          />

          <ChatMessageList {...messageListProps} />
          {forwardSelectionBar}

          <div
            className="an-chat-composer-dock flex-shrink-0 px-3 sm:px-4 pb-4 pt-2"
            style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
          >
            <MessageComposer {...composerProps} />
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col">
          {isMobile && (
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3 flex-shrink-0">
              <button
                type="button"
                onClick={onOpenSidebar}
                aria-label="Open navigation"
                className="w-8 h-8 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 flex-shrink-0"
              >
                <AppIcon name="menu" className="w-6 h-6" />
              </button>
              <span
                className="text-sm font-semibold text-gray-700"
                data-i18n-skip
              >
                {mobileBrandLabel}
              </span>
            </div>
          )}
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-20 h-20 rounded-3xl bg-gray-100 flex items-center justify-center mb-5">
              <AppIcon name="messageCircle" className="w-10 h-10 text-gray-300" />
            </div>
            <p className="text-gray-700 text-[15px] font-semibold">
              {isPersonalWorkspace ? "Select a DM or Group" : "Select a channel"}
            </p>
            <p className="text-gray-400 text-[13px] mt-1.5">
              {isPersonalWorkspace ? (
                "Select a DM, file, or Group on the left."
              ) : (
                <>
                  Select a channel on the left to start chatting, or{" "}
                  <span className="text-[#1264A3]">create a new channel</span>
                </>
              )}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
