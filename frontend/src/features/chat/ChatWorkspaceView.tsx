import type { Dispatch, ReactNode, SetStateAction } from "react";
import { AppIcon } from "../../components/icons/AppIcon";
import { ChannelHeader, type MemoryTab } from "../../components/ChannelHeader";
import {
  MessageComposer,
  type MessageComposerProps,
} from "../../components/MessageComposer";
import { SessionScopePanel } from "../../components/SessionScopePanel";
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
  const topics = topicRoots
    .map((root) => {
      const replies = topicRepliesOf(root.msg_id);
      const isExplicit = root.msg_type === "topic";
      if (!isExplicit && replies.length < TOPIC_DISPLAY_THRESHOLD) {
        return null;
      }
      const title =
        (root.content || "").replace(/\s+/g, " ").trim().slice(0, 60) ||
        "(无标题)";
      const last = replies[replies.length - 1];
      return {
        rootId: root.msg_id,
        title,
        count: replies.length,
        lastTime: last?.created_at ? formatTs(last.created_at) : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <>
      <ChatTaskOverlay {...taskOverlayProps} />
      <ChatTopicOverlay {...topicOverlayProps} />

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
            onRefreshDmSession={activeBotDm ? onRefreshDmSession : undefined}
            refreshingDmSession={refreshingDmSession}
            sessionAction={
              activeBotDm && activeDmSessionScopeId ? (
                <SessionScopePanel
                  scopeType="dm"
                  scopeId={activeDmSessionScopeId}
                  channelId={selectedId}
                  botId={activeBotDm.counterparty.member_id}
                  title="DM 对应 Session"
                  refreshKey={dmSessionRefreshNonce}
                  variant="toolbar"
                />
              ) : (
                selectedChannel?.type !== "dm" && (
                  <SessionScopePanel
                    scopeType="channel"
                    scopeId={selectedId}
                    channelId={selectedId}
                    title="频道对应 Session"
                    variant="toolbar"
                  />
                )
              )
            }
          />

          <ChatMessageList {...messageListProps} />
          {forwardSelectionBar}

          <div
            className="flex-shrink-0 px-3 sm:px-4 pb-4 pt-2"
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
                className="w-8 h-8 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 flex-shrink-0"
              >
                <AppIcon name="menu" className="w-6 h-6" />
              </button>
              <span className="text-sm font-semibold text-gray-700">
                智枢协作
              </span>
            </div>
          )}
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-20 h-20 rounded-3xl bg-gray-100 flex items-center justify-center mb-5">
              <AppIcon name="messageCircle" className="w-10 h-10 text-gray-300" />
            </div>
            <p className="text-gray-700 text-[15px] font-semibold">
              {isPersonalWorkspace ? "选择一个私信或 Project" : "选择一个频道"}
            </p>
            <p className="text-gray-400 text-[13px] mt-1.5">
              {isPersonalWorkspace ? (
                "从左侧选择私信、文件或 Project。"
              ) : (
                <>
                  从左侧选择频道开始对话，或{" "}
                  <span className="text-[#1264A3]">创建新频道</span>
                </>
              )}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
