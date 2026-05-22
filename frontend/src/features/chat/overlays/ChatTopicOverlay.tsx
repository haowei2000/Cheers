import { lazy, Suspense } from "react";
import type { ChangeEvent, ReactNode } from "react";
import type { FileDragReference } from "../../../lib/file-drag";
import { LazyPanelFallback } from "../../../components/app/LazyPanelFallback";
import { AppIcon } from "../../../components/icons/AppIcon";
import { SessionScopePanel } from "../../../components/SessionScopePanel";
import type { SessionScopeTarget } from "../../../components/SessionScopePanel";
import type {
  ComposerKeychainItem,
  ComposerPendingFile,
} from "../../../components/MessageComposer";
import type { Channel, ChannelBot, ChannelUser, Message } from "../../../types";

const TopicPage = lazy(() =>
  import("../../../components/TopicPage").then((module) => ({
    default: module.TopicPage,
  })),
);

export interface ChatTopicOverlayProps {
  open: boolean;
  selectedId: string | null;
  pageTopicId: string | null;
  sourceMessages: Message[];
  repliesOf: (rootId: string) => Message[];
  channel: Channel | null;
  channelBots: ChannelBot[];
  channelUsers: ChannelUser[];
  currentUserId: string | null;
  pageTopicError: string | null;
  pageTopicLoading: boolean;
  onBack: () => void;
  onSendReply: (channelId: string, rootMsgId: string, text: string) => Promise<void> | void;
  onCopyMessage: (message: Message) => Promise<void> | void;
  onForwardMessage?: (message: Message) => void;
  onToggleForwardSelection?: (message: Message) => void;
  forwardSelectionMode?: boolean;
  selectedForwardMsgIds?: string[];
  onShowMessageDetails: (message: Message) => void;
  hasMessageDetails: (message: Message) => boolean;
  onImageClick: (src: string) => void;
  onFileClick: (url: string, filename: string) => void;
  renderAttachments: (message: Message) => ReactNode;
  pendingFiles: ComposerPendingFile[];
  onRemovePendingFile: (index: number) => void;
  onUploadFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onUploadFiles: (files: File[]) => void | Promise<void>;
  onAttachFiles: (files: FileDragReference[]) => void;
  keychainEnabled: boolean;
  keychainOpen: boolean;
  keychainLoading: boolean;
  keychainItems: ComposerKeychainItem[];
  onToggleKeychain: () => void;
  onCloseKeychain: () => void;
  onOpenSessionScope?: (target: SessionScopeTarget) => void;
}

export function ChatTopicOverlay({
  open,
  selectedId,
  pageTopicId,
  sourceMessages,
  repliesOf,
  channel,
  channelBots,
  channelUsers,
  currentUserId,
  pageTopicError,
  pageTopicLoading,
  onBack,
  onSendReply,
  onCopyMessage,
  onForwardMessage,
  onToggleForwardSelection,
  forwardSelectionMode = false,
  selectedForwardMsgIds = [],
  onShowMessageDetails,
  hasMessageDetails,
  onImageClick,
  onFileClick,
  renderAttachments,
  pendingFiles,
  onRemovePendingFile,
  onUploadFile,
  onUploadFiles,
  onAttachFiles,
  keychainEnabled,
  keychainOpen,
  keychainLoading,
  keychainItems,
  onToggleKeychain,
  onCloseKeychain,
  onOpenSessionScope,
}: ChatTopicOverlayProps) {
  if (!open || !selectedId || !pageTopicId) return null;

  const rootMsg = sourceMessages.find((message) => message.msg_id === pageTopicId);
  const rootId = pageTopicId;

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
      {rootMsg ? (
        <Suspense fallback={<LazyPanelFallback label="Loading topic view..." />}>
          <TopicPage
            rootMsg={rootMsg}
            replies={repliesOf(rootId)}
            channel={channel}
            channelBots={channelBots}
            channelUsers={channelUsers}
            currentUserId={currentUserId || ""}
            onBack={onBack}
            onGoToChannel={onBack}
            onSendReply={(text, inReplyToMsgId) =>
              onSendReply(selectedId, inReplyToMsgId ?? rootId, text)
            }
            onCopyMessage={onCopyMessage}
            onForwardMessage={onForwardMessage}
            onToggleForwardSelection={onToggleForwardSelection}
            forwardSelectionMode={forwardSelectionMode}
            selectedForwardMsgIds={selectedForwardMsgIds}
            onShowMessageDetails={onShowMessageDetails}
            hasMessageDetails={hasMessageDetails}
            onImageClick={onImageClick}
            onFileClick={onFileClick}
            renderAttachments={renderAttachments}
            pendingFiles={pendingFiles}
            onRemovePendingFile={onRemovePendingFile}
            onUploadFile={onUploadFile}
            onUploadFiles={onUploadFiles}
            onAttachFiles={onAttachFiles}
            keychainEnabled={keychainEnabled}
            keychainOpen={keychainOpen}
            keychainLoading={keychainLoading}
            keychainItems={keychainItems}
            onToggleKeychain={onToggleKeychain}
            onCloseKeychain={onCloseKeychain}
            sessionPanel={
              <SessionScopePanel
                scopeType="topic"
                scopeId={rootId}
                channelId={selectedId}
                title="Topic sessions"
                variant="toolbar"
                onOpenScope={onOpenSessionScope}
              />
            }
          />
        </Suspense>
      ) : (
        <div className="an-topic-page">
          <div className="an-head an-tpp-top">
            <button type="button" className="an-tpp-back" onClick={onBack}>
              <AppIcon name="arrowLeft" className="w-4 h-4" />
              <span>Channel</span>
            </button>
            <div className="an-tpp-meta">
              <div className="an-tpp-crumbs">
                <span>{channel ? `#${channel.name}` : "Channels"}</span>
                <span className="an-sep">›</span>
                <span>Topics</span>
              </div>
              <h1 className="an-title an-tpp-title">
                <span className="an-hash">
                  <AppIcon name="messageCircle" />
                </span>
                <span>
                  {pageTopicError ||
                    (pageTopicLoading ? "Loading topic messages" : "Topic message not found")}
                </span>
              </h1>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
