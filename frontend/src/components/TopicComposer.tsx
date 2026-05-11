/* TopicComposer — topic-scoped wrapper around the regular channel composer.
 * It keeps the shared composer chrome, but locks the topic page to ordinary
 * message mode: no secret, announcement, or new-topic switching. */
import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { ChannelBot, ChannelUser } from "../types";
import {
  MessageComposer,
  type ComposerKeychainItem,
  type ComposerPendingFile,
} from "./MessageComposer";

export interface TopicComposerProps {
  placeholder: string;
  channelBots: ChannelBot[];
  channelUsers: ChannelUser[];
  onSend: (text: string) => Promise<void> | void;
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
  onSend,
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

  const submit = async () => {
    if (!canSend || busy) return;
    setBusy(true);
    try {
      await onSend(value);
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
      pendingFiles={pendingFiles}
      onRemovePendingFile={onRemovePendingFile}
      onUploadFile={onUploadFile}
      keychainEnabled={keychainEnabled}
      keychainOpen={keychainOpen}
      keychainLoading={keychainLoading}
      keychainItems={keychainItems}
      onToggleKeychain={onToggleKeychain}
      onCloseKeychain={onCloseKeychain}
      sendButtonLabel={busy ? "发送中…" : "回复"}
      normalHint={
        <>
          <kbd>@</kbd> 提及 · <kbd>↵</kbd> 发送 · <kbd>⇧↵</kbd> 换行 ·
          在这里的回复只留在本主题里
        </>
      }
    />
  );
}
