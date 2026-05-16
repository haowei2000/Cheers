import { lazy, Suspense } from "react";
import { LazyPanelFallback } from "../../../components/app/LazyPanelFallback";
import type { Channel, ChannelBot } from "../../../types";
import type { AgentBridgeTaskMessage } from "../../../lib/agent-bridge";

const TaskPage = lazy(() =>
  import("../../../components/TaskPage").then((module) => ({
    default: module.TaskPage,
  })),
);

export interface ChatTaskOverlayProps {
  open: boolean;
  isDmSelected: boolean;
  selectedId: string | null;
  tasks: AgentBridgeTaskMessage[];
  selectedMsgId: string | null;
  channel: Channel | null;
  channelBots: ChannelBot[];
  onSelectTask: (msgId: string) => void;
  onBack: () => void;
  onJumpToMessage: (msgId: string) => void;
}

export function ChatTaskOverlay({
  open,
  isDmSelected,
  selectedId,
  tasks,
  selectedMsgId,
  channel,
  channelBots,
  onSelectTask,
  onBack,
  onJumpToMessage,
}: ChatTaskOverlayProps) {
  if (!open || isDmSelected || !selectedId) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--bg-0)",
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <Suspense fallback={<LazyPanelFallback label="Loading task view..." />}>
        <TaskPage
          tasks={tasks}
          selectedMsgId={selectedMsgId}
          channel={channel}
          channelBots={channelBots}
          onSelectTask={onSelectTask}
          onBack={onBack}
          onJumpToMessage={onJumpToMessage}
        />
      </Suspense>
    </div>
  );
}
