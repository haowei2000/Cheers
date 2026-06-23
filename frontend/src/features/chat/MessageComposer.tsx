import {
  useState,
  useRef,
  useCallback,
  type KeyboardEvent,
  type FormEvent,
} from "react";
import { SendHorizontal, Bot, User, Paperclip, X, FileText } from "lucide-react";
import { cn } from "@/lib/cn";
import { uploadFile } from "@/api/files";
import type { FileInfo } from "@/types";

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
  onSend: (
    content: string,
    mentionIds: string[],
    fileIds: string[]
  ) => Promise<void>;
}

interface PickerState {
  /** index into `text` of the active "@" trigger */
  at: number;
  query: string;
  index: number;
}

export function MessageComposer({
  channelId,
  channelName,
  disabled,
  mentionables = [],
  onSend,
}: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<FileInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  // Mentions the user has picked, keyed by id. Routing source of truth.
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  // Recompute the active "@query" token from the text up to the caret.
  // Active only when "@" starts a word and the token has no whitespace.
  const refreshPicker = useCallback((value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at === -1) return setPicker(null);
    const token = upto.slice(at + 1);
    const startsWord = at === 0 || /\s/.test(value[at - 1]);
    if (!startsWord || /\s/.test(token)) return setPicker(null);
    setPicker({ at, query: token, index: 0 });
  }, []);

  const filtered = picker
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
      const pos = picker.at + c.label.length + 2; // "@label "
      el?.focus();
      el?.setSelectionRange(pos, pos);
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
    if (picker && filtered.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPicker({ ...picker, index: (picker.index + 1) % filtered.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPicker({
          ...picker,
          index: (picker.index - 1 + filtered.length) % filtered.length,
        });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectCandidate(filtered[picker.index]);
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
      {picker && filtered.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-2 max-h-60 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl z-10">
          {filtered.map((c, i) => (
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

      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border bg-zinc-800/80 px-3 py-2 transition-colors",
          disabled
            ? "border-zinc-800 opacity-60"
            : "border-zinc-700 hover:border-zinc-600 focus-within:border-indigo-500/60 focus-within:bg-zinc-800"
        )}
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || !channelId}
          className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 disabled:opacity-40 transition-colors mb-0.5"
          aria-label="Attach file"
        >
          <Paperclip className="w-4 h-4" />
        </button>

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
        <kbd className="font-mono">@</kbd> to mention
      </p>
    </div>
  );
}
