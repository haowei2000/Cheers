/* TopicComposer — topic-scoped wrapper around the regular channel composer.
 * It keeps the shared composer chrome, but locks the topic page to ordinary
 * message mode: no secret, announcement, or new-topic switching. */
import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { ChannelBot, ChannelUser, Message } from "../types";
import {
  MessageComposer,
  type ComposerKeychainItem,
  type ComposerPendingFile,
} from "./MessageComposer";

export interface TopicComposerProps {
  placeholder: string;
  channelBots: ChannelBot[];
  channelUsers: ChannelUser[];
  currentUserId?: string;
  onSend: (text: string) => Promise<void> | void;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
  pendingFiles?: ComposerPendingFile[];
  onRemovePendingFile?: (index: number) => void;
  onUploadFile?: (event: ChangeEvent<HTMLInputElement>) => void;
  keychainEnabled?: boolean;
  keychainOpen?: boolean;
  keychainLoading?: boolean;
  keychainItems?: ComposerKeychainItem[];
  onToggleKeychain?: () => void;
  onCloseKeychain?: () => void;
}

export function TopicComposer({
  placeholder,
  channelBots,
  channelUsers,
  currentUserId,
  onSend,
  replyingTo = null,
  onCancelReply,
  pendingFiles = [],
  onRemovePendingFile,
  onUploadFile,
  keychainEnabled = false,
  keychainOpen = false,
  keychainLoading = false,
  keychainItems = [],
  onToggleKeychain,
  onCloseKeychain,
}: TopicComposerProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = Boolean(value.trim() || pendingFiles.length > 0);

  const submit = async (draftValue: string) => {
    const content = draftValue.trim() ? draftValue : value;
    if ((!content.trim() && pendingFiles.length === 0) || busy) return;
    setBusy(true);
    try {
      await onSend(content);
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <MessageComposer
      value={value}
      inputRef={inputRef}
      onValueChange={setValue}
      onSend={submit}
      canSend={canSend && !busy}
      placeholder={placeholder}
      disabled={busy}
      kind="normal"
      normalOnly
      showKindSwitcher={false}
      enableKindCycling={false}
      channelBots={channelBots}
      channelUsers={channelUsers}
      currentUserId={currentUserId}
      replyingTo={replyingTo}
      onCancelReply={onCancelReply}
      pendingFiles={pendingFiles}
      onRemovePendingFile={onRemovePendingFile}
      onUploadFile={onUploadFile}
      keychainEnabled={keychainEnabled}
      keychainOpen={keychainOpen}
      keychainLoading={keychainLoading}
      keychainItems={keychainItems}
      onToggleKeychain={onToggleKeychain}
      onCloseKeychain={onCloseKeychain}
      sendButtonLabel={busy ? "Sending..." : "Reply"}
      normalHint={
        <>
          <kbd>@</kbd> mentions · <kbd>↵</kbd> Send · <kbd>⇧↵</kbd> line break ·
          Replies here stay in this topic
        </>
      }
    />
  );
}
