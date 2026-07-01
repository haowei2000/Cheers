import {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  type KeyboardEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  SendHorizontal,
  Bot,
  User,
  Paperclip,
  X,
  FileText,
  Upload,
  FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { uploadFile } from "@/api/files";
import type { FileInfo } from "@/types";
import { CommandPalette, type CommandCandidate } from "./CommandPalette";
import { ExistingFilePicker } from "./ExistingFilePicker";

export type { CommandCandidate } from "./CommandPalette";

export interface MentionCandidate {
  id: string;
  type: "user" | "bot";
  label: string;
  sublabel?: string;
}

interface Props {
  channelId?: string;
  channelName?: string;
  disabled?: boolean;
  mentionables?: MentionCandidate[];
  /** Slash-commands advertised by the channel's bots (⑦ command palette). */
  commands?: CommandCandidate[];
  /** Optional controls rendered just above the input row (e.g. a session switcher). */
  toolbar?: ReactNode;
  /** Fires with the bots currently @mentioned in the draft (token still present),
      so the parent can surface per-bot controls contextual to the mention. */
  onMentionsChange?: (mentionedBots: MentionCandidate[]) => void;
  onSend: (
    content: string,
    mentionIds: string[],
    fileIds: string[]
  ) => Promise<void>;
}

// The composer runs one picker at a time, opened by either "@" (mention) or "/"
// (command). `kind` says which list to filter and how a selection is inserted.
interface PickerState {
  kind: "mention" | "command";
  /** index into `text` of the active trigger char ("@" or "/") */
  at: number;
  query: string;
  index: number;
}

export function MessageComposer({
  channelId,
  channelName,
  disabled,
  mentionables = [],
  commands = [],
  toolbar,
  onMentionsChange,
  onSend,
}: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<FileInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  // Mentions the user has picked, keyed by id. Routing source of truth.
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [picker, setPicker] = useState<PickerState | null>(null);
  // Paperclip → small menu (upload vs. pick existing) + the channel-file picker dialog.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLDivElement>(null);

  // Bots whose "@label" token still survives in the draft — the live mention set
  // (mirrors submit()'s routing filter). Emitted up so the parent can show the
  // mentioned bot's session controls. Keyed by id so we only notify on change.
  const mentionedBots = useMemo(
    () => picked.filter((p) => p.type === "bot" && text.includes(`@${p.label}`)),
    [picked, text]
  );
  const mentionKey = mentionedBots.map((b) => b.id).join(",");
  useEffect(() => {
    onMentionsChange?.(mentionedBots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionKey]);

  async function handleFiles(files: FileList | null) {
    if (!files || !channelId) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const info = await uploadFile(channelId, file);
        setAttachments((prev) => [...prev, info]);
      }
    } catch {
      /* keep the composer usable; failed uploads just won't attach */
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeAttachment(fileId: string) {
    setAttachments((prev) => prev.filter((a) => a.file_id !== fileId));
  }

  // Attach files already uploaded to the channel — append, deduped by file_id (submit()
  // maps attachments → file_ids, so existing files flow through unchanged, no re-upload).
  function addExisting(files: FileInfo[]) {
    setAttachments((prev) => {
      const have = new Set(prev.map((a) => a.file_id));
      return [...prev, ...files.filter((f) => !have.has(f.file_id))];
    });
  }

  // Close the attach menu on outside click / Escape.
  useEffect(() => {
    if (!attachMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (attachRef.current && !attachRef.current.contains(e.target as Node))
        setAttachMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) =>
      e.key === "Escape" && setAttachMenuOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [attachMenuOpen]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  // Recompute the active picker token from the text up to the caret. The picker
  // opens on whichever trigger ("@" mention or "/" command) most recently starts
  // a word before the caret; it stays open only while the token has no whitespace.
  const refreshPicker = useCallback((value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const atPos = upto.lastIndexOf("@");
    const slashPos = upto.lastIndexOf("/");
    // The later trigger wins (it's the one the caret is actually inside).
    const pos = Math.max(atPos, slashPos);
    if (pos === -1) return setPicker(null);
    const kind = pos === atPos ? "mention" : "command";
    const token = upto.slice(pos + 1);
    const startsWord = pos === 0 || /\s/.test(value[pos - 1]);
    if (!startsWord || /\s/.test(token)) return setPicker(null);
    setPicker({ kind, at: pos, query: token, index: 0 });
  }, []);

  const filteredMentions =
    picker?.kind === "mention"
      ? mentionables
          .filter((c) => {
            const q = picker.query.toLowerCase();
            return (
              c.label.toLowerCase().includes(q) ||
              (c.sublabel?.toLowerCase().includes(q) ?? false)
            );
          })
          // bots first — they are the demo's primary @target
          .sort((a, b) => (a.type === b.type ? 0 : a.type === "bot" ? -1 : 1))
          .slice(0, 8)
      : [];

  const filteredCommands =
    picker?.kind === "command"
      ? commands
          .filter((c) => {
            const q = picker.query.toLowerCase();
            return (
              c.name.toLowerCase().includes(q) ||
              (c.description?.toLowerCase().includes(q) ?? false)
            );
          })
          .slice(0, 8)
      : [];

  // The active list length drives keyboard navigation regardless of which picker
  // is open.
  const activeCount =
    picker?.kind === "command" ? filteredCommands.length : filteredMentions.length;

  function selectCandidate(c: MentionCandidate) {
    if (!picker) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next =
      text.slice(0, picker.at) + `@${c.label} ` + text.slice(caret);
    setText(next);
    setPicked((prev) =>
      prev.some((p) => p.id === c.id) ? prev : [...prev, c]
    );
    setPicker(null);
    requestAnimationFrame(() => {
      const newPos = picker.at + c.label.length + 2; // "@label "
      el?.focus();
      el?.setSelectionRange(newPos, newPos);
      adjustHeight();
    });
  }

  // Insert "/name " at the active "/" trigger. Commands are not routed like
  // mentions — they live inline in the message text for the bot to interpret.
  function selectCommand(c: CommandCandidate) {
    if (!picker) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = text.slice(0, picker.at) + `/${c.name} ` + text.slice(caret);
    setText(next);
    setPicker(null);
    requestAnimationFrame(() => {
      const newPos = picker.at + c.name.length + 2; // "/name "
      el?.focus();
      el?.setSelectionRange(newPos, newPos);
      adjustHeight();
    });
  }

  async function submit() {
    const typed = text.trim();
    const fileIds = attachments.map((a) => a.file_id);
    // Backend requires non-empty content; fall back to attachment names.
    const content =
      typed ||
      (fileIds.length
        ? attachments.map((a) => a.original_filename || "file").join(", ")
        : "");
    if (!content || sending || uploading || disabled) return;
    // Only keep mentions whose "@label" token still survives in the text.
    const ids = Array.from(
      new Set(
        picked.filter((p) => typed.includes(`@${p.label}`)).map((p) => p.id)
      )
    );
    setSending(true);
    setText("");
    setPicked([]);
    setPicker(null);
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    try {
      await onSend(content, ids, fileIds);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (picker && activeCount) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPicker({ ...picker, index: (picker.index + 1) % activeCount });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPicker({
          ...picker,
          index: (picker.index - 1 + activeCount) % activeCount,
        });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (picker.kind === "command") selectCommand(filteredCommands[picker.index]);
        else selectCandidate(filteredMentions[picker.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPicker(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function handleInput(e: FormEvent<HTMLTextAreaElement>) {
    const value = e.currentTarget.value;
    setText(value);
    refreshPicker(value, e.currentTarget.selectionStart ?? value.length);
    adjustHeight();
  }

  const canSend =
    (text.trim().length > 0 || attachments.length > 0) &&
    !sending &&
    !uploading &&
    !disabled;

  return (
    <div className="px-4 pb-4 pt-2 relative">
      {picker?.kind === "mention" && filteredMentions.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-2 max-h-60 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl z-10">
          {filteredMentions.map((c, i) => (
            <button
              key={c.id}
              onMouseDown={(e) => {
                e.preventDefault();
                selectCandidate(c);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                i === picker.index
                  ? "bg-indigo-600/30 text-zinc-100"
                  : "text-zinc-300 hover:bg-zinc-800"
              )}
            >
              {c.type === "bot" ? (
                <Bot className="w-4 h-4 text-indigo-400 flex-shrink-0" />
              ) : (
                <User className="w-4 h-4 text-zinc-400 flex-shrink-0" />
              )}
              <span className="font-medium">{c.label}</span>
              {c.sublabel && (
                <span className="text-xs text-zinc-500">@{c.sublabel}</span>
              )}
              {c.type === "bot" && (
                <span className="ml-auto text-[10px] px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300">
                  BOT
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {picker?.kind === "command" && filteredCommands.length > 0 && (
        <CommandPalette
          commands={filteredCommands}
          activeIndex={picker.index}
          onSelect={selectCommand}
        />
      )}

      {(attachments.length > 0 || uploading) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <span
              key={a.file_id}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300"
            >
              <FileText className="w-3.5 h-3.5 text-indigo-400" />
              <span className="max-w-[160px] truncate">
                {a.original_filename || a.file_id.slice(0, 8)}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.file_id)}
                className="text-zinc-500 hover:text-zinc-200"
                aria-label="Remove attachment"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {uploading && (
            <span className="inline-flex items-center text-xs text-zinc-500 px-1">
              uploading…
            </span>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {libraryOpen && channelId && (
        <ExistingFilePicker
          channelId={channelId}
          attachedIds={attachments.map((a) => a.file_id)}
          onPick={addExisting}
          onClose={() => setLibraryOpen(false)}
        />
      )}

      {toolbar && <div className="mb-2 flex flex-wrap items-center gap-2">{toolbar}</div>}

      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border bg-zinc-800/80 px-3 py-2 transition-colors",
          disabled
            ? "border-zinc-800 opacity-60"
            : "border-zinc-700 hover:border-zinc-600 focus-within:border-indigo-500/60 focus-within:bg-zinc-800"
        )}
      >
        <div ref={attachRef} className="relative flex-shrink-0 mb-0.5">
          <button
            type="button"
            onClick={() => setAttachMenuOpen((o) => !o)}
            disabled={disabled || !channelId}
            className={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40",
              attachMenuOpen
                ? "text-zinc-200 bg-zinc-700/50"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50"
            )}
            aria-label="Attach file"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          {attachMenuOpen && (
            <div className="absolute bottom-full left-0 mb-1.5 w-48 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl z-20">
              <button
                type="button"
                onClick={() => {
                  setAttachMenuOpen(false);
                  fileInputRef.current?.click();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800"
              >
                <Upload className="w-3.5 h-3.5 text-zinc-500" />
                从电脑上传
              </button>
              <button
                type="button"
                onClick={() => {
                  setAttachMenuOpen(false);
                  setLibraryOpen(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800"
              >
                <FolderOpen className="w-3.5 h-3.5 text-zinc-500" />
                选择频道文件
              </button>
            </div>
          )}
        </div>

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onClick={(e) =>
            refreshPicker(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? 0
            )
          }
          disabled={disabled || sending}
          placeholder={
            disabled
              ? "Select a channel to start chatting"
              : `Message ${channelName ? `#${channelName}` : "..."} — @ to mention a bot`
          }
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 resize-none outline-none leading-relaxed py-1 min-h-[24px] max-h-[200px]"
        />

        <button
          onClick={() => void submit()}
          disabled={!canSend}
          className={cn(
            "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-150 mb-0.5",
            canSend
              ? "bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer shadow-sm"
              : "bg-zinc-700/50 text-zinc-600 cursor-not-allowed"
          )}
          aria-label="Send message"
        >
          <SendHorizontal className="w-4 h-4" />
        </button>
      </div>
      <p className="text-[11px] text-zinc-600 mt-1.5 px-1">
        <kbd className="font-mono">Enter</kbd> to send ·{" "}
        <kbd className="font-mono">Shift+Enter</kbd> for new line ·{" "}
        <kbd className="font-mono">@</kbd> to mention ·{" "}
        <kbd className="font-mono">/</kbd> for commands
      </p>
    </div>
  );
}
