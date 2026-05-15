import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { parseHelperPayload } from "../lib/helper";
import type { ChannelBot, ChannelUser, Message } from "../types";
import { AppIcon } from "./icons/AppIcon";
import { FileTypeIcon } from "./icons/FileTypeIcon";

export type MessageComposerKind = "normal" | "secret" | "announcement" | "topic";

export const MESSAGE_COMPOSER_KIND_ORDER: MessageComposerKind[] = [
  "normal",
  "secret",
  "announcement",
  "topic",
];

const MESSAGE_COMPOSER_KIND_LABEL: Record<MessageComposerKind, string> = {
  normal: "消息",
  secret: "加密",
  announcement: "公告",
  topic: "主题",
};

export interface ComposerPendingFile {
  name: string;
  previewUrl: string | null;
}

export interface ComposerKeychainItem {
  key_id: string;
  name: string;
}

export interface MessageComposerProps {
  value: string;
  valueRevision?: number;
  inputRef: RefObject<HTMLTextAreaElement>;
  onValueChange: (value: string) => void;
  onSend: (value: string) => void;
  canSend: boolean;
  canSendPredicate?: (value: string) => boolean;
  placeholder: string;
  disabled?: boolean;
  kind: MessageComposerKind;
  onKindChange?: (kind: MessageComposerKind) => void;
  onCycleKind?: (direction: 1 | -1) => void;
  showKindSwitcher?: boolean;
  enableKindCycling?: boolean;
  normalOnly?: boolean;
  titleValue?: string;
  titleRef?: RefObject<HTMLInputElement>;
  onTitleChange?: (value: string) => void;
  channelBots: ChannelBot[];
  channelUsers: ChannelUser[];
  currentUserId?: string;
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
  sendButtonLabel?: string;
  normalHint?: ReactNode;
}

type MentionItem = (ChannelBot | ChannelUser) & {
  kind: "bot" | "user";
};

export function MessageComposer({
  value,
  valueRevision = 0,
  inputRef,
  onValueChange,
  onSend,
  canSend,
  canSendPredicate,
  placeholder,
  disabled = false,
  kind,
  onKindChange,
  onCycleKind,
  showKindSwitcher = true,
  enableKindCycling = true,
  normalOnly = false,
  titleValue = "",
  titleRef,
  onTitleChange,
  channelBots,
  channelUsers,
  currentUserId,
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
  sendButtonLabel,
  normalHint,
}: MessageComposerProps) {
  const [draftValue, setDraftValue] = useState(value);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionPlacement, setMentionPlacement] = useState<"top" | "bottom">(
    "bottom",
  );
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const uploadMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const keychainRef = useRef<HTMLDivElement | null>(null);
  const displayKind: MessageComposerKind = normalOnly ? "normal" : kind;
  const effectiveCanSend = canSendPredicate
    ? canSendPredicate(draftValue)
    : canSend;

  useEffect(() => {
    setDraftValue(value);
  }, [value, valueRevision]);

  useEffect(() => {
    if (!uploadMenuOpen) return;
    const handle = (event: MouseEvent) => {
      if (
        uploadMenuRef.current &&
        !uploadMenuRef.current.contains(event.target as Node)
      ) {
        setUploadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [uploadMenuOpen]);

  useEffect(() => {
    if (!keychainOpen) return;
    const handle = (event: MouseEvent) => {
      if (
        keychainRef.current &&
        !keychainRef.current.contains(event.target as Node)
      ) {
        onCloseKeychain?.();
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [keychainOpen, onCloseKeychain]);

  const mentionItems = useMemo<MentionItem[]>(
    () => [
      ...channelBots.map((bot) => ({ ...bot, kind: "bot" as const })),
      ...channelUsers.map((user) => ({ ...user, kind: "user" as const })),
    ],
    [channelBots, channelUsers],
  );

  const matchedMentionItems = useMemo(() => {
    if (!mentionOpen) return [];
    const filter = mentionFilter.toLowerCase();
    return mentionItems.filter(
      (item) =>
        item.username.toLowerCase().includes(filter) ||
        (item.display_name ?? "").toLowerCase().includes(filter),
    );
  }, [mentionFilter, mentionItems, mentionOpen]);

  const insertAtCursor = (snippet: string) => {
    const el = inputRef.current;
    const currentValue = el?.value ?? draftValue;
    if (!el) {
      const next = currentValue + snippet;
      setDraftValue(next);
      onValueChange(next);
      return;
    }
    const start = el.selectionStart ?? currentValue.length;
    const end = el.selectionEnd ?? currentValue.length;
    const next =
      currentValue.slice(0, start) + snippet + currentValue.slice(end);
    setDraftValue(next);
    onValueChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const pickMention = (item: MentionItem) => {
    const el = inputRef.current;
    const currentValue = el?.value ?? draftValue;
    const pos = el?.selectionStart ?? currentValue.length;
    const lastAt = currentValue.lastIndexOf("@", pos - 1);
    const insert = `@${item.username} `;
    const next =
      lastAt === -1
        ? currentValue.slice(0, pos) + insert + currentValue.slice(pos)
        : currentValue.slice(0, lastAt) + insert + currentValue.slice(pos);
    const caret = lastAt === -1 ? pos + insert.length : lastAt + insert.length;
    setDraftValue(next);
    onValueChange(next);
    setMentionOpen(false);
    setTimeout(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    }, 0);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    const pos = event.target.selectionStart ?? next.length;
    setDraftValue(next);
    onValueChange(next);
    const lastAt = next.lastIndexOf("@", pos - 1);
    if (lastAt !== -1) {
      const after = next.slice(lastAt + 1, pos);
      if (!after.includes(" ") && !after.includes("\n")) {
        const rect = event.target.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        setMentionPlacement(
          spaceBelow < 180 && spaceAbove > spaceBelow ? "top" : "bottom",
        );
        setMentionOpen(true);
        setMentionFilter(after);
        return;
      }
    }
    setMentionOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && event.key === "Escape") {
      setMentionOpen(false);
      return;
    }
    if (
      event.key === "Tab" &&
      !mentionOpen &&
      !replyingTo &&
      showKindSwitcher &&
      enableKindCycling &&
      !normalOnly
    ) {
      event.preventDefault();
      onCycleKind?.(event.shiftKey ? -1 : 1);
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !mentionOpen
    ) {
      event.preventDefault();
      if (effectiveCanSend) onSend(event.currentTarget.value);
    }
  };

  const handleResizeDown = (event: PointerEvent<HTMLDivElement>) => {
    const startH = inputRef.current?.offsetHeight ?? 40;
    dragRef.current = { startY: event.clientY, startH };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setTextareaHeight(
      Math.max(40, Math.min(600, drag.startH + (drag.startY - event.clientY))),
    );
  };

  const handleResizeUp = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer may already be released */
    }
  };

  const removePendingFile = (index: number, previewUrl: string | null) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    onRemovePendingFile?.(index);
  };

  const titlePlaceholder =
    displayKind === "announcement"
      ? "标题（可选，例如「周五发布窗口」）…"
      : "主题标题（可选，例如「升级计划讨论」）…";
  const shouldShowKindhead = !replyingTo;
  const placementClass =
    mentionPlacement === "top" ? "bottom-full mb-1" : "top-full mt-1";

  return (
    <>
      {showKindSwitcher && !replyingTo && !normalOnly && (
        <div className="an-msgkind-switcher">
          <button
            type="button"
            onClick={() => onCycleKind?.(-1)}
            className="an-msgkind-arrow"
            title="上一种消息类型 (Shift+Tab)"
            aria-label="上一种消息类型"
          >
            ‹
          </button>
          <span
            className={
              "an-msgkind-label inline-flex items-center gap-1.5" +
              (displayKind === "secret"
                ? " is-secret"
                : displayKind === "announcement"
                  ? " is-announcement"
                  : displayKind === "topic"
                    ? " is-topic"
                    : "")
            }
            title="Tab 切换 · Shift+Tab 反向"
          >
            {displayKind === "secret" ? (
              <AppIcon name="lock" className="w-3.5 h-3.5" />
            ) : displayKind === "announcement" ? (
              <AppIcon name="announcement" className="w-3.5 h-3.5" />
            ) : displayKind === "topic" ? (
              <AppIcon name="messageCircle" className="w-3.5 h-3.5" />
            ) : (
              <AppIcon name="message" className="w-3.5 h-3.5" />
            )}
            {MESSAGE_COMPOSER_KIND_LABEL[displayKind]}
          </span>
          <button
            type="button"
            onClick={() => onCycleKind?.(1)}
            className="an-msgkind-arrow"
            title="下一种消息类型 (Tab)"
            aria-label="下一种消息类型"
          >
            ›
          </button>
        </div>
      )}

      {replyingTo &&
        (() => {
          const refBot =
            replyingTo.sender_type === "bot"
              ? channelBots.find((bot) => bot.member_id === replyingTo.sender_id)
              : null;
          const refUser =
            replyingTo.sender_type === "user"
              ? channelUsers.find((user) => user.member_id === replyingTo.sender_id)
              : null;
          const refLabel =
            replyingTo.sender_type === "bot"
              ? refBot?.display_name || refBot?.username || "Bot"
              : replyingTo.sender_id === currentUserId
                ? "我"
                : replyingTo.sender_name ||
                  refUser?.display_name ||
                  refUser?.username ||
                  "用户";
          const refText =
            parseHelperPayload(replyingTo.content).text || replyingTo.content;
          const refPreview = refText.replace(/\n/g, " ").slice(0, 80);
          return (
            <div className="an-reply-quote mb-1" style={{ maxWidth: "none" }}>
              <span className="an-rq-arrow">↪</span>
              <span className="an-rq-name">{refLabel}</span>
              <span className="an-rq-snip">
                {refPreview}
                {refText.length > 80 ? "…" : ""}
              </span>
              <button
                type="button"
                onClick={onCancelReply}
                className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full hover:bg-[var(--surface-hover)]"
                style={{ color: "var(--fg-3)" }}
                title="取消回复"
              >
                <AppIcon name="close" className="w-3 h-3" />
              </button>
            </div>
          );
        })()}

      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingFiles.map((file, index) =>
            file.previewUrl ? (
              <div
                key={`${file.name}:${index}`}
                className="relative group cursor-pointer rounded-xl overflow-hidden border border-gray-200 shadow-sm inline-block"
              >
                <img
                  src={file.previewUrl}
                  alt={file.name}
                  className="max-w-[180px] max-h-[140px] object-cover block"
                />
                <div className="px-2.5 py-1.5 bg-white text-[11px] text-gray-500 border-t border-gray-100 flex items-center gap-1.5 max-w-[180px]">
                  <AppIcon name="image" className="w-3 h-3 text-gray-400 flex-shrink-0" />
                  <span className="truncate">{file.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removePendingFile(index, file.previewUrl)}
                  className="absolute top-1 right-1 w-5 h-5 bg-black/50 text-white rounded-full text-[11px] leading-none items-center justify-center flex sm:hidden sm:group-hover:flex"
                >
                  ×
                </button>
              </div>
            ) : (
              <div
                key={`${file.name}:${index}`}
                className="relative group flex items-center gap-2.5 px-3 py-2.5 bg-white border border-gray-200 rounded-xl shadow-sm max-w-[240px]"
              >
                <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                  <FileTypeIcon filename={file.name} size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-gray-700 truncate">
                    {file.name}
                  </div>
                  <div className="text-[11px] text-gray-400">待发送</div>
                </div>
                <button
                  type="button"
                  onClick={() => removePendingFile(index, null)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-500 text-white rounded-full text-[11px] leading-none items-center justify-center flex sm:hidden sm:group-hover:flex"
                >
                  ×
                </button>
              </div>
            ),
          )}
        </div>
      )}

      <div className="relative">
        <div
          className={
            "an-composer overflow-hidden" +
            (!replyingTo && displayKind === "secret"
              ? " is-secret"
              : !replyingTo && displayKind === "announcement"
                ? " is-announcement"
                : !replyingTo && displayKind === "topic"
                  ? " is-topic"
                  : "")
          }
        >
          <div
            className="an-composer-resize"
            onPointerDown={handleResizeDown}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeUp}
            onPointerCancel={handleResizeUp}
            onDoubleClick={() => setTextareaHeight(null)}
            title="拖拽调整高度 · 双击重置"
            aria-label="拖拽调整发送框高度"
          >
            <span className="an-composer-resize-grip" />
          </div>

          {shouldShowKindhead && (
            <div className="an-composer-kindhead">
              {(displayKind === "announcement" || displayKind === "topic") && (
                <input
                  ref={titleRef}
                  className="an-composer-title"
                  placeholder={titlePlaceholder}
                  value={titleValue}
                  onChange={(event) => onTitleChange?.(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      inputRef.current?.focus();
                    }
                  }}
                  maxLength={120}
                />
              )}
              {displayKind === "secret" && (
                <span className="an-composer-kindhead-hint">
                  端到端加密 · 仅 @ 的 Bot 可读原文
                </span>
              )}
              {displayKind === "normal" && (
                <span className="an-composer-kindhead-hint">
                  {normalHint ?? "@ 呼叫 Bot · Tab 切换类型 · ↵ 发送"}
                </span>
              )}
            </div>
          )}

          <textarea
            ref={inputRef}
            value={draftValue}
            disabled={disabled}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="an-composer-textarea"
            style={
              textareaHeight !== null
                ? { height: textareaHeight, maxHeight: textareaHeight }
                : undefined
            }
            rows={1}
          />

          <div className="an-composer-bar">
            <div className="flex items-center gap-1">
              {keychainEnabled && (
                <div ref={keychainRef} className="relative">
                  <button
                    type="button"
                    onClick={onToggleKeychain}
                    className={
                      "an-composer-iconbtn" + (keychainOpen ? " is-active" : "")
                    }
                    title="插入密钥链"
                  >
                    <AppIcon name="key" className="w-4 h-4" />
                  </button>
                  {keychainOpen && (
                    <div
                      className="an-menu absolute"
                      style={{
                        bottom: 40,
                        left: 0,
                        minWidth: 220,
                        maxHeight: 256,
                        overflowY: "auto",
                      }}
                    >
                      <div className="an-menu-head">插入密钥</div>
                      {keychainLoading ? (
                        <div className="an-menu-empty">加载中…</div>
                      ) : keychainItems.length === 0 ? (
                        <div className="an-menu-empty">
                          暂无密钥
                          <br />
                          <span style={{ opacity: 0.7 }}>
                            点击侧边栏钥匙图标添加
                          </span>
                        </div>
                      ) : (
                        keychainItems.map((item) => (
                          <button
                            key={item.key_id}
                            type="button"
                            onClick={() => {
                              insertAtCursor(`$secret{${item.name}}`);
                              onCloseKeychain?.();
                            }}
                            className="an-menu-item"
                          >
                            <span className="an-mi-ico">
                              <AppIcon name="help" className="w-3.5 h-3.5" />
                            </span>
                            <span className="font-mono truncate">
                              {item.name}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}

              {onUploadFile && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,.docx,.pdf,.xlsx,.png,.jpg,.jpeg,.webp,.gif"
                    className="hidden"
                    onChange={onUploadFile}
                  />
                  <div ref={uploadMenuRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setUploadMenuOpen((open) => !open)}
                      className={
                        "an-composer-iconbtn" +
                        (uploadMenuOpen ? " is-active" : "")
                      }
                      title="上传文件和图片"
                    >
                      <AppIcon name="plus" className="w-[18px] h-[18px]" />
                    </button>
                    {uploadMenuOpen && (
                      <div
                        className="an-menu absolute"
                        style={{ bottom: 40, left: 0, minWidth: 180 }}
                      >
                        <button
                          type="button"
                          className="an-menu-item"
                          onClick={() => {
                            setUploadMenuOpen(false);
                            fileInputRef.current?.click();
                          }}
                        >
                          <span className="an-mi-ico">
                            <AppIcon name="link" className="w-4 h-4" />
                          </span>
                          <span>上传文件和图片</span>
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}

              <button
                type="button"
                onClick={() => {
                  insertAtCursor("@");
                  setMentionFilter("");
                  setMentionPlacement("top");
                  setMentionOpen(true);
                }}
                className="an-composer-iconbtn"
                title="提及成员或 Bot"
              >
                <span className="text-[15px] font-semibold leading-none">@</span>
              </button>
              <button
                type="button"
                onClick={() => insertAtCursor("\n")}
                className="an-composer-iconbtn is-kbd"
                title="插入换行（快捷键 Shift+Enter）"
              >
                <span className="an-kbd-glyph">⇧↵</span>
              </button>
            </div>

            {!normalOnly &&
              (displayKind === "normal" || displayKind === "secret") && (
                <button
                  type="button"
                  onClick={() =>
                    onKindChange?.(
                      displayKind === "secret" ? "normal" : "secret",
                    )
                  }
                  title={
                    displayKind === "secret"
                      ? "取消加密模式"
                      : "开启加密模式（仅 Bot 可读原文）"
                  }
                  className={
                    "an-composer-iconbtn ml-auto" +
                    (displayKind === "secret" ? " is-secret-on" : "")
                  }
                >
                  <AppIcon name="lock" className="w-4 h-4" />
                </button>
              )}

            <button
              type="button"
              onClick={() => onSend(inputRef.current?.value ?? draftValue)}
              className="an-composer-send"
              disabled={disabled || !effectiveCanSend}
            >
              {sendButtonLabel ?? (displayKind === "secret" ? "加密发送" : "发送")}
            </button>
          </div>
        </div>

        {mentionOpen && matchedMentionItems.length > 0 && (
          <ul
            className={`an-menu absolute left-0 right-0 ${placementClass}`}
            style={{ maxHeight: 240, overflowY: "auto" }}
            role="listbox"
          >
            <li className="an-menu-head" style={{ listStyle: "none" }}>
              @提及 · {matchedMentionItems.length} 项
            </li>
            {matchedMentionItems.map((item) => (
              <li
                key={`${item.kind}:${item.member_id}`}
                role="option"
                className="an-menu-item"
                style={{ listStyle: "none" }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickMention(item);
                }}
              >
                <span
                  className="an-mi-ico"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 5,
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 700,
                    background:
                      item.kind === "bot" ? "var(--green)" : "var(--accent)",
                  }}
                >
                  {item.username.slice(0, 1).toUpperCase()}
                </span>
                <div className="flex flex-col min-w-0 flex-1">
                  <span
                    className="font-medium truncate"
                    style={{ color: "var(--fg-1)" }}
                  >
                    @{item.username}
                  </span>
                  {item.display_name && (
                    <span className="an-mi-sub truncate">
                      {item.display_name}
                    </span>
                  )}
                </div>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{
                    background:
                      item.kind === "bot"
                        ? "var(--green-muted)"
                        : "var(--accent-muted)",
                    color:
                      item.kind === "bot" ? "var(--green)" : "var(--accent)",
                  }}
                >
                  {item.kind === "bot" ? "Bot" : "用户"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
