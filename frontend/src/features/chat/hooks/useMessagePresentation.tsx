import { useCallback, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import { AppIcon } from "../../../components/icons/AppIcon";
import {
  getActiveAgentBridgeTaskData,
  getAgentBridgeTaskData,
  type AgentBridgeTaskMessage,
} from "../../../lib/agent-bridge";
import { patchMessage, type MessageStore } from "../../../lib/message-store";
import type {
  AgentBridgeTaskContentData,
  MemoryLoadDetail,
  Message,
} from "../../../types";
import { AgentBridgeTaskCard } from "../messages/AgentBridgeTaskCard";

interface UseMessagePresentationOptions {
  selectedId: string | null;
  authToken: string | null;
  isDmSelected: boolean;
  messages: Message[];
  setMessageStore: Dispatch<SetStateAction<MessageStore>>;
  onShowMessageDetails: (message: Message) => void;
  onOpenAgentBridgeTask: (messageId: string) => void;
}

export function useMessagePresentation({
  selectedId,
  authToken,
  isDmSelected,
  messages,
  setMessageStore,
  onShowMessageDetails,
  onOpenAgentBridgeTask,
}: UseMessagePresentationOptions) {
  const getMemoryLoadDetail = useCallback((message: Message): MemoryLoadDetail | null => {
    const value = message.content_data?.memory_load;
    if (!value || typeof value !== "object") return null;
    const detail = value as MemoryLoadDetail;
    return detail.kind === "bot_memory_load" ? detail : null;
  }, []);

  const hasBotReplyDetails = useCallback(
    (message: Message): boolean =>
      message.sender_type === "bot" &&
      Boolean(getMemoryLoadDetail(message) || message._bot_trace?.length),
    [getMemoryLoadDetail],
  );

  const renderMemoryLoadButton = useCallback(
    (message: Message) => {
      if (!hasBotReplyDetails(message)) return null;
      return (
        <button
          type="button"
          onClick={() => onShowMessageDetails(message)}
          title="查看这条 AI 回复的记忆与流式事件"
          className="an-chat-action"
        >
          <AppIcon name="help" className="h-3.5 w-3.5" />
        </button>
      );
    },
    [hasBotReplyDetails, onShowMessageDetails],
  );

  const cancelStreamingMessage = useCallback(
    async (message: Message) => {
      if (!selectedId) return;
      setMessageStore((prev) =>
        patchMessage(prev, message.msg_id, (item) => ({
          ...item,
          _streaming: false,
        })),
      );
      try {
        const response = await apiFetch(
          `/channels/${selectedId}/messages/${message.msg_id}/cancel`,
          { method: "POST", token: authToken },
        );
        if (!response.ok) {
          setMessageStore((prev) =>
            patchMessage(prev, message.msg_id, (item) => ({
              ...item,
              _streaming: true,
            })),
          );
          toast.error("取消失败");
        }
      } catch {
        setMessageStore((prev) =>
          patchMessage(prev, message.msg_id, (item) => ({
            ...item,
            _streaming: true,
          })),
        );
        toast.error("取消失败");
      }
    },
    [authToken, selectedId, setMessageStore],
  );

  const renderStopStreamButton = useCallback(
    (message: Message) => {
      if (!message._streaming || message.sender_type !== "bot") return null;
      return (
        <button
          type="button"
          title="停止生成"
          onClick={() => cancelStreamingMessage(message)}
          className="inline-flex items-center justify-center align-middle ml-1.5 w-5 h-5 rounded border"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-soft)",
            color: "var(--fg-2)",
            cursor: "pointer",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              background: "currentColor",
              borderRadius: 1,
            }}
          />
        </button>
      );
    },
    [cancelStreamingMessage],
  );

  const renderPartialBadge = useCallback((message: Message) => {
    if (message._streaming || !message.is_partial || message.sender_type !== "bot") {
      return null;
    }
    return (
      <span
        className="inline-block align-middle ml-1.5 px-1.5 py-0.5 rounded text-[10px]"
        style={{
          background: "var(--surface-soft)",
          border: "1px solid var(--border)",
          color: "var(--fg-3)",
        }}
      >
        已取消
      </span>
    );
  }, []);

  const renderBotTraceStatus = useCallback((message: Message) => {
    if (!message._streaming || message.sender_type !== "bot" || !message._bot_status) {
      return null;
    }
    return (
      <div
        className="mt-1 flex items-center gap-1.5 text-[11px] leading-snug"
        style={{ color: "var(--fg-3)" }}
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: "var(--fg-3)" }}
        />
        <span className="truncate max-w-[min(520px,70vw)]">
          {message._bot_status}
        </span>
      </div>
    );
  }, []);

  const activeAgentBridgeTaskData = useCallback(
    (message: Message): AgentBridgeTaskContentData | null =>
      getActiveAgentBridgeTaskData(message, isDmSelected),
    [isDmSelected],
  );

  const agentBridgeTaskData = useCallback(
    (message: Message): AgentBridgeTaskContentData | null =>
      getAgentBridgeTaskData(message, isDmSelected),
    [isDmSelected],
  );

  const agentBridgeTaskMessages = useMemo(() => {
    if (isDmSelected) return [];
    return messages
      .map((message) => {
        const task = agentBridgeTaskData(message);
        return task
          ? ({ ...message, content_data: task } as AgentBridgeTaskMessage)
          : null;
      })
      .filter((message): message is AgentBridgeTaskMessage => message !== null);
  }, [agentBridgeTaskData, isDmSelected, messages]);

  const renderAgentBridgeTaskCard = useCallback(
    (message: Message) => {
      const task = activeAgentBridgeTaskData(message);
      if (!task) return null;
      return (
        <AgentBridgeTaskCard
          message={message}
          task={task}
          onOpen={onOpenAgentBridgeTask}
        />
      );
    },
    [activeAgentBridgeTaskData, onOpenAgentBridgeTask],
  );

  return {
    getMemoryLoadDetail,
    hasBotReplyDetails,
    renderMemoryLoadButton,
    renderStopStreamButton,
    renderPartialBadge,
    renderBotTraceStatus,
    activeAgentBridgeTaskData,
    agentBridgeTaskMessages,
    renderAgentBridgeTaskCard,
  };
}
