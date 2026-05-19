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
import { MemberIdentity } from "./members";

export type MessageComposerKind = "normal" | "secret" | "announcement" | "topic";

export const MESSAGE_COMPOSER_KIND_ORDER: MessageComposerKind[] = [
  "normal",
  "secret",
  "announcement",
  "topic",
];

const MESSAGE_COMPOSER_KIND_LABEL: Record<MessageComposerKind, string> = {
  normal: "Messages",
  secret: "Encrypted",
  announcement: "Announcement",
  topic: "Topics",
};

function promptTemplateDisplayName(template?: ComposerPromptTemplate | null): string {
  if (!template) return "";
  const name = template.name.trim();
  if (!name || /^__.*__$/.test(name) || name.includes("__openclaw_passthrough__")) {
    return "System passthrough template";
  }
  return name;
}

export interface ComposerPendingFile {
  name: string;
  previewUrl: string | null;
}

export interface ComposerKeychainItem {
  key_id: string;
  name: string;
}

export interface ComposerPromptTemplate {
  template_id: string;
  name: string;
  description?: string | null;
  is_builtin?: boolean;
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
  promptTemplates?: ComposerPromptTemplate[];
  promptTemplatesLoading?: boolean;
  selectedPromptTemplateId?: string | null;
  onPromptTemplateChange?: (templateId: string | null) => void;
  sendButtonLabel?: string;
  normalHint?: ReactNode;
}

type MentionItem = (ChannelBot | ChannelUser) & {
  kind: "bot" | "user";
};

type ComposerTextRange = {
  start: number;
  end: number;
};

type LeadingBotMentionMatch = ComposerTextRange & {
  username: string;
};

const MENTION_NAME_BOUNDARY_RE = /^[a-zA-Z0-9_\-'\u4e00-\u9fff]$/;

function findLeadingBotMentionMatch(
  value: string,
  botUsernames: string[],
): LeadingBotMentionMatch | null {
  const names = [...new Set(botUsernames.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) return null;
  const lowerValue = value.toLowerCase();

  let pos = 0;
  while (pos < value.length && (value[pos] === " " || value[pos] === "\t")) {
    pos += 1;
  }
  const start = pos;
  let consumed = false;
  let firstUsername = "";

  while (value[pos] === "@") {
    const name = names.find((candidate) => {
      const mention = `@${candidate}`;
      if (!lowerValue.startsWith(mention.toLowerCase(), pos)) return false;
      const nextChar = value[pos + mention.length];
      return !nextChar || !MENTION_NAME_BOUNDARY_RE.test(nextChar);
    });
    if (name) {
      if (!firstUsername) firstUsername = name;
      pos += name.length + 1;
      consumed = true;
    } else if (consumed) {
      pos += 1;
      while (pos < value.length && MENTION_NAME_BOUNDARY_RE.test(value[pos])) {
        pos += 1;
      }
    } else {
      break;
    }
    while (pos < value.length && (value[pos] === " " || value[pos] === "\t")) {
      pos += 1;
    }
  }

  return consumed && firstUsername ? { start, end: pos, username: firstUsername } : null;
}

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
  promptTemplates = [],
  promptTemplatesLoading = false,
  selectedPromptTemplateId = null,
  onPromptTemplateChange,
  sendButtonLabel,
  normalHint,
}: MessageComposerProps) {
  const [draftValue, setDraftValue] = useState(value);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionTriggerRange, setMentionTriggerRange] =
    useState<ComposerTextRange | null>(null);
  const [mentionTriggerLabel, setMentionTriggerLabel] = useState("");
  const [mentionPlacement, setMentionPlacement] = useState<"top" | "bottom">(
    "bottom",
  );
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [templateFilter, setTemplateFilter] = useState("");
  const [templateTriggerRange, setTemplateTriggerRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [textareaHeight, setTextareaHeight] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const actionTriggerRef = useRef<HTMLDivElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const keychainMenuRef = useRef<HTMLDivElement | null>(null);
  const templateTriggerRef = useRef<HTMLDivElement | null>(null);
  const templateMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const displayKind: MessageComposerKind = normalOnly ? "normal" : kind;
  const effectiveCanSend = canSendPredicate
    ? canSendPredicate(draftValue)
    : canSend;
  const selectedPromptTemplate = useMemo(
    () =>
      promptTemplates.find(
        (template) => template.template_id === selectedPromptTemplateId,
      ) || null,
    [promptTemplates, selectedPromptTemplateId],
  );
  const selectedPromptTemplateName = promptTemplateDisplayName(selectedPromptTemplate);
  const hasPromptTemplateControl = Boolean(onPromptTemplateChange);
  const leadingBotMention = useMemo(
    () =>
      findLeadingBotMentionMatch(
        draftValue,
        channelBots.map((bot) => bot.username),
      ),
    [channelBots, draftValue],
  );
  const leadingBotMentionLabel = useMemo(() => {
    if (!leadingBotMention) return "";
    const bot = channelBots.find(
      (item) => item.username.toLowerCase() === leadingBotMention.username.toLowerCase(),
    );
    return bot?.display_name?.trim() || bot?.username || leadingBotMention.username;
  }, [channelBots, leadingBotMention]);

  useEffect(() => {
    setDraftValue(value);
    if (!value.trim()) setMentionTriggerLabel("");
  }, [value, valueRevision]);

  const closeTemplateMenu = () => {
    setTemplateMenuOpen(false);
    setTemplateFilter("");
    setTemplateTriggerRange(null);
  };

  const closeMentionMenu = () => {
    setMentionOpen(false);
    setMentionFilter("");
    setMentionTriggerRange(null);
  };

  useEffect(() => {
    if (!actionMenuOpen) return;
    const handle = (event: MouseEvent) => {
      if (
        actionTriggerRef.current &&
        !actionTriggerRef.current.contains(event.target as Node) &&
        actionMenuRef.current &&
        !actionMenuRef.current.contains(event.target as Node)
      ) {
        setActionMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [actionMenuOpen]);

  useEffect(() => {
    if (!templateMenuOpen) return;
    const handle = (event: MouseEvent) => {
      if (
        templateTriggerRef.current &&
        !templateTriggerRef.current.contains(event.target as Node) &&
        templateMenuRef.current &&
        !templateMenuRef.current.contains(event.target as Node)
      ) {
        closeTemplateMenu();
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [templateMenuOpen]);

  useEffect(() => {
    if (!keychainOpen) return;
    const handle = (event: MouseEvent) => {
      if (
        (!actionTriggerRef.current ||
          !actionTriggerRef.current.contains(event.target as Node)) &&
        (!actionMenuRef.current ||
          !actionMenuRef.current.contains(event.target as Node)) &&
        keychainMenuRef.current &&
        !keychainMenuRef.current.contains(event.target as Node)
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

  const matchedPromptTemplates = useMemo(() => {
    if (!templateMenuOpen) return [];
    const filter = templateFilter.trim().toLowerCase();
    if (!filter) return promptTemplates;
    return promptTemplates.filter((template) => {
      const name = promptTemplateDisplayName(template).toLowerCase();
      const description = (template.description ?? "").toLowerCase();
      return name.includes(filter) || description.includes(filter);
    });
  }, [promptTemplates, templateFilter, templateMenuOpen]);

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

  const getTextareaSelectionRange = (): ComposerTextRange => {
    const el = inputRef.current;
    const currentValue = el?.value ?? draftValue;
    const start = el?.selectionStart ?? currentValue.length;
    const end = el?.selectionEnd ?? start;
    return {
      start: Math.min(start, currentValue.length),
      end: Math.min(Math.max(end, start), currentValue.length),
    };
  };

  const replaceTextareaRange = (
    range: ComposerTextRange,
    replacement: string,
  ) => {
    const el = inputRef.current;
    const currentValue = el?.value ?? draftValue;
    const start = Math.min(range.start, currentValue.length);
    const end = Math.min(Math.max(range.end, start), currentValue.length);
    const next =
      currentValue.slice(0, start) + replacement + currentValue.slice(end);
    const caret = start + replacement.length;
    setDraftValue(next);
    onValueChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const pickMention = (item: MentionItem) => {
    const el = inputRef.current;
    const currentValue = el?.value ?? draftValue;
    const selection = getTextareaSelectionRange();
    const pos = selection.end;
    const lastAt = currentValue.lastIndexOf("@", pos - 1);
    const insert = `@${item.username} `;
    const leadingBotMentionRange =
      item.kind === "bot"
        ? findLeadingBotMentionMatch(
            currentValue,
            channelBots.map((bot) => bot.username),
          )
        : null;
    const range =
      leadingBotMentionRange ??
      mentionTriggerRange ??
      (lastAt === -1
        ? selection
        : {
            start: lastAt,
            end: pos,
          });
    replaceTextareaRange(range, insert);
    setMentionTriggerLabel(
      item.kind === "bot" ? "" : item.display_name?.trim() || item.username,
    );
    closeMentionMenu();
  };

  const clearTemplateTriggerText = () => {
    if (!templateTriggerRange) return;
    const el = inputRef.current;
    const currentValue = el?.value ?? draftValue;
    const start = Math.min(templateTriggerRange.start, currentValue.length);
    const end = Math.min(
      Math.max(templateTriggerRange.end, start),
      currentValue.length,
    );
    const next = currentValue.slice(0, start) + currentValue.slice(end);
    setDraftValue(next);
    onValueChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, start);
    });
  };

  const pickPromptTemplate = (templateId: string | null) => {
    onPromptTemplateChange?.(templateId);
    clearTemplateTriggerText();
    closeTemplateMenu();
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    const pos = event.target.selectionStart ?? next.length;
    setDraftValue(next);
    onValueChange(next);
    if (!next.trim()) setMentionTriggerLabel("");
    const lastAt = next.lastIndexOf("@", pos - 1);
    const lastSlash = next.lastIndexOf("/", pos - 1);
    const atFilter = lastAt === -1 ? null : next.slice(lastAt + 1, pos);
    const slashFilter = lastSlash === -1 ? null : next.slice(lastSlash + 1, pos);
    const atIsActive = atFilter !== null && !/\s/.test(atFilter);
    const slashIsActive =
      hasPromptTemplateControl &&
      slashFilter !== null &&
      !/\s/.test(slashFilter) &&
      (lastSlash === 0 || /\s/.test(next.charAt(lastSlash - 1)));

    if (slashIsActive && lastSlash > lastAt) {
      setActionMenuOpen(false);
      onCloseKeychain?.();
      closeMentionMenu();
      setTemplateFilter(slashFilter);
      setTemplateTriggerRange({ start: lastSlash, end: pos });
      setTemplateMenuOpen(true);
      return;
    }

    closeTemplateMenu();
    if (atIsActive) {
      const rect = event.target.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setMentionPlacement(
        spaceBelow < 180 && spaceAbove > spaceBelow ? "top" : "bottom",
      );
      setMentionOpen(true);
      setMentionFilter(atFilter);
      setMentionTriggerRange({ start: lastAt, end: pos });
      return;
    }
    closeMentionMenu();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && event.key === "Escape") {
      closeMentionMenu();
      return;
    }
    if (templateMenuOpen && event.key === "Escape") {
      closeTemplateMenu();
      return;
    }
    if (
      event.key === "Tab" &&
      !mentionOpen &&
      !templateMenuOpen &&
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
      !mentionOpen &&
      !templateMenuOpen
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
      ? "Title (optional, e.g. “Friday release window”)..."
      : "Topic title (optional, e.g. “Upgrade planning”)...";
  const shouldShowKindhead = !replyingTo;
  const placementClass =
    mentionPlacement === "top" ? "bottom-full mb-1" : "top-full mt-1";
  const toolbarMenuClass = "an-menu absolute left-0 right-0 bottom-full mb-1";
  const shouldShowKindSwitcher =
    showKindSwitcher && !replyingTo && !normalOnly;

  const handleMentionButtonClick = () => {
    setActionMenuOpen(false);
    closeTemplateMenu();
    onCloseKeychain?.();
    inputRef.current?.focus();
    setMentionOpen((open) => {
      if (open) {
        setMentionFilter("");
        setMentionTriggerRange(null);
        return false;
      }
      setMentionFilter("");
      setMentionTriggerRange(getTextareaSelectionRange());
      setMentionPlacement("top");
      return true;
    });
  };

  const handleTemplateButtonClick = () => {
    setActionMenuOpen(false);
    onCloseKeychain?.();
    closeMentionMenu();
    setTemplateFilter("");
    setTemplateTriggerRange(null);
    setTemplateMenuOpen((open) => !open);
  };

  const handleActionButtonClick = () => {
    closeTemplateMenu();
    closeMentionMenu();
    onCloseKeychain?.();
    setActionMenuOpen((open) => !open);
  };

  const promptTemplateTriggerLabel = selectedPromptTemplateName || "Skill";
  const hasMentionButtonSelection = Boolean(leadingBotMentionLabel || mentionTriggerLabel);
  const mentionButtonLabel = leadingBotMentionLabel || mentionTriggerLabel || "Agent";

  const selectKind = (nextKind: MessageComposerKind) => {
    onKindChange?.(nextKind);
    setActionMenuOpen(false);
  };

  return (
    <>
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
                ? "Me"
                : replyingTo.sender_name ||
                  refUser?.display_name ||
                  refUser?.username ||
                  "User";
          const refText =
            parseHelperPayload(replyingTo.content).text || replyingTo.content;
          const refPreview = refText.replace(/\n/g, " ").slice(0, 80);
          return (
            <div className="an-reply-quote mb-1" style={{ maxWidth: "none" }}>
              <span className="an-rq-arrow">↪</span>
              <span className="an-rq-name">{refLabel}</span>
              <span className="an-rq-snip">
                {refPreview}
                {refText.length > 80 ? "..." : ""}
              </span>
              <button
                type="button"
                onClick={onCancelReply}
                className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full hover:bg-[var(--surface-hover)]"
                style={{ color: "var(--fg-3)" }}
                title="CancelReply"
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
                className="relative group cursor-pointer rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--bg-1)] shadow-sm inline-block"
              >
                <img
                  src={file.previewUrl}
                  alt={file.name}
                  className="max-w-[180px] max-h-[140px] object-cover block"
                />
                <div className="px-2.5 py-1.5 bg-[var(--bg-1)] text-[var(--fg-3)] border-t border-[var(--border)] flex items-center gap-1.5 max-w-[180px] an-type-caption">
                  <AppIcon name="image" className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{file.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removePendingFile(index, file.previewUrl)}
                  className="absolute top-1 right-1 w-5 h-5 bg-black/50 text-white rounded-full leading-none items-center justify-center flex sm:hidden sm:group-hover:flex"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                >
                  <AppIcon name="close" className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <div
                key={`${file.name}:${index}`}
                className="relative group flex items-center gap-2.5 px-3 py-2.5 bg-[var(--bg-1)] border border-[var(--border)] rounded-lg shadow-sm max-w-[240px]"
              >
                <div className="w-9 h-9 rounded-md bg-[var(--accent-muted)] flex items-center justify-center flex-shrink-0">
                  <FileTypeIcon filename={file.name} size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="an-type-label text-[var(--fg-2)] truncate">
                    {file.name}
                  </div>
                  <div className="an-type-caption text-[var(--fg-3)]">Pending send</div>
                </div>
                <button
                  type="button"
                  onClick={() => removePendingFile(index, null)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-[var(--fg-3)] text-white rounded-full leading-none items-center justify-center flex sm:hidden sm:group-hover:flex"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                >
                  <AppIcon name="close" className="w-3 h-3" />
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
            title="Drag to resize height · double-click to reset"
            aria-label="Drag to resize composer"
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
                  End-to-end encrypted · only mentioned bots can read the original
                </span>
              )}
              {displayKind === "normal" && (
                <span className="an-composer-kindhead-hint">
                  {normalHint ?? "@ Agent · Tab switches type · Enter sends"}
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
              {onUploadFile && (
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,.html,.htm,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.wps,.et,.dps,.ofd,.rtf,.csv,.zip,.rar,.7z,.tar,.gz,.bz2,.xz,.dwg,.dxf,.epub,.pdf,.png,.jpg,.jpeg,.webp,.gif"
                  className="hidden"
                  onChange={onUploadFile}
                />
              )}

              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleMentionButtonClick}
                className="an-composer-iconbtn is-named-trigger"
                title="Choose agent or member"
                aria-label="Choose agent or member"
              >
                <span className="an-composer-glyph">@</span>
                <span
                  className="an-composer-trigger-label"
                  data-i18n-skip={hasMentionButtonSelection ? "" : undefined}
                >
                  {mentionButtonLabel}
                </span>
              </button>

              {onPromptTemplateChange && (
                <div ref={templateTriggerRef} className="an-composer-template-trigger relative">
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={handleTemplateButtonClick}
                    className={
                      "an-composer-iconbtn is-named-trigger" +
                      (templateMenuOpen || selectedPromptTemplate ? " is-active" : "")
                    }
                    title={
                      selectedPromptTemplate
                        ? `Forced template: ${selectedPromptTemplateName}`
                        : "Choose a prompt template override for this message"
                    }
                    aria-label="Choose prompt template"
                  >
                    <span className="an-composer-glyph">/</span>
                    <span className="an-composer-trigger-label">{promptTemplateTriggerLabel}</span>
                  </button>
                </div>
              )}

              <div ref={actionTriggerRef} className="relative">
                <button
                  type="button"
                  onClick={handleActionButtonClick}
                  className={
                    "an-composer-iconbtn" +
                    (actionMenuOpen || keychainOpen ? " is-active" : "")
                  }
                  title="More composer actions"
                  aria-label="More composer actions"
                  aria-expanded={actionMenuOpen}
                >
                  <AppIcon name="more" className="w-4 h-4" />
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onSend(inputRef.current?.value ?? draftValue)}
              className="an-composer-send"
              disabled={disabled || !effectiveCanSend}
              aria-label={sendButtonLabel ?? (displayKind === "secret" ? "Send encrypted" : "Send")}
            >
              {sendButtonLabel ?? (displayKind === "secret" ? "Send encrypted" : "Send")}
            </button>
          </div>
        </div>

        {keychainOpen && (
          <div
            ref={keychainMenuRef}
            className={toolbarMenuClass}
            style={{
              maxHeight: 256,
              overflowY: "auto",
            }}
          >
            <div className="an-menu-head">Insert secret</div>
            {keychainLoading ? (
              <div className="an-menu-empty">Loading...</div>
            ) : keychainItems.length === 0 ? (
              <div className="an-menu-empty">
                No secrets
                <br />
                <span style={{ opacity: 0.7 }}>Click the key icon in the sidebar to add one</span>
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
                  <span className="font-mono truncate">{item.name}</span>
                </button>
              ))
            )}
          </div>
        )}

        {actionMenuOpen && (
          <div ref={actionMenuRef} className={toolbarMenuClass}>
            <div className="an-menu-head">Composer actions</div>
            {keychainEnabled && (
              <button
                type="button"
                className={"an-menu-item" + (keychainOpen ? " on" : "")}
                onClick={() => {
                  setActionMenuOpen(false);
                  onToggleKeychain?.();
                }}
              >
                <span className="an-mi-ico">
                  <AppIcon name="key" className="w-3.5 h-3.5" />
                </span>
                <span>Insert keychain secret</span>
              </button>
            )}
            {onUploadFile && (
              <button
                type="button"
                className="an-menu-item"
                onClick={() => {
                  setActionMenuOpen(false);
                  fileInputRef.current?.click();
                }}
              >
                <span className="an-mi-ico">
                  <AppIcon name="attachment" className="w-3.5 h-3.5" />
                </span>
                <span>Upload files and images</span>
              </button>
            )}
            <button
              type="button"
              className="an-menu-item"
              onClick={() => {
                insertAtCursor("\n");
                setActionMenuOpen(false);
              }}
            >
              <span className="an-mi-ico">
                <span className="an-kbd-glyph">⇧↵</span>
              </span>
              <span>Insert line break</span>
            </button>

            {shouldShowKindSwitcher && (
              <>
                <div className="an-menu-sep" />
                <div className="an-menu-head">Message type</div>
                {MESSAGE_COMPOSER_KIND_ORDER.map((kindOption) => (
                  <button
                    key={kindOption}
                    type="button"
                    className={
                      "an-menu-item an-composer-kind-option" +
                      (kindOption === displayKind ? " on" : "")
                    }
                    onClick={() => selectKind(kindOption)}
                    disabled={!onKindChange}
                  >
                    <span className="an-mi-ico">
                      {kindOption === "secret" ? (
                        <AppIcon name="lock" className="w-3.5 h-3.5" />
                      ) : kindOption === "announcement" ? (
                        <AppIcon name="announcement" className="w-3.5 h-3.5" />
                      ) : kindOption === "topic" ? (
                        <AppIcon name="messageCircle" className="w-3.5 h-3.5" />
                      ) : (
                        <AppIcon name="message" className="w-3.5 h-3.5" />
                      )}
                    </span>
                    <span>{MESSAGE_COMPOSER_KIND_LABEL[kindOption]}</span>
                    {kindOption === displayKind && (
                      <span className="an-mi-ck">
                        <AppIcon name="check" className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {templateMenuOpen && (
          <div
            ref={templateMenuRef}
            className={`${toolbarMenuClass} an-composer-template-menu is-open${
              templateTriggerRange ? " is-keyboard-open" : ""
            }`}
            style={{
              maxHeight: 300,
              overflowY: "auto",
            }}
          >
            <div className="an-menu-head">Skill · Force override for this message</div>
            {selectedPromptTemplate && (
              <button
                type="button"
                className="an-menu-item"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickPromptTemplate(null)}
              >
                <span className="an-mi-ico">
                  <AppIcon name="close" className="w-3.5 h-3.5" />
                </span>
                <span>Clear template override</span>
              </button>
            )}
            {promptTemplatesLoading ? (
              <div className="an-menu-empty">Loading...</div>
            ) : promptTemplates.length === 0 ? (
              <div className="an-menu-empty">No templates available</div>
            ) : matchedPromptTemplates.length === 0 ? (
              <div className="an-menu-empty">No matching templates</div>
            ) : (
              matchedPromptTemplates.map((template) => (
                <button
                  key={template.template_id}
                  type="button"
                  className="an-menu-item"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pickPromptTemplate(template.template_id)}
                >
                  <span className="an-mi-ico">
                    {template.template_id === selectedPromptTemplateId ? (
                      <AppIcon name="check" className="w-3.5 h-3.5" />
                    ) : (
                      <span className="an-composer-glyph">/</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{promptTemplateDisplayName(template)}</span>
                    {template.description && (
                      <span
                        className="an-type-caption block truncate"
                        style={{ color: "var(--fg-3)" }}
                      >
                        {template.description}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {mentionOpen && matchedMentionItems.length > 0 && (
          <ul
            className={`an-menu absolute left-0 right-0 ${placementClass}`}
            style={{ maxHeight: 240, overflowY: "auto" }}
            role="listbox"
          >
            <li className="an-menu-head" style={{ listStyle: "none" }}>
              @mentions · {matchedMentionItems.length} items
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
                <MemberIdentity
                  avatarSize={24}
                  member={{
                    ...item,
                    display_name: item.username,
                    member_type: item.kind,
                  }}
                  primaryPrefix="@"
                  showBadge
                  sub={item.display_name}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
