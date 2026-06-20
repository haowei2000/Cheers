import {
  useState,
  useRef,
  useCallback,
  type KeyboardEvent,
  type FormEvent,
} from "react";
import { SendHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

interface Props {
  channelName?: string;
  disabled?: boolean;
  onSend: (content: string) => Promise<void>;
}

export function MessageComposer({ channelName, disabled, onSend }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  async function submit() {
    const content = text.trim();
    if (!content || sending || disabled) return;
    setSending(true);
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    try {
      await onSend(content);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function handleInput(e: FormEvent<HTMLTextAreaElement>) {
    setText(e.currentTarget.value);
    adjustHeight();
  }

  const canSend = text.trim().length > 0 && !sending && !disabled;

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border bg-zinc-800/80 px-3 py-2 transition-colors",
          disabled
            ? "border-zinc-800 opacity-60"
            : "border-zinc-700 hover:border-zinc-600 focus-within:border-indigo-500/60 focus-within:bg-zinc-800"
        )}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending}
          placeholder={
            disabled
              ? "Select a channel to start chatting"
              : `Message ${channelName ? `#${channelName}` : "..."}`
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
        <kbd className="font-mono">Shift+Enter</kbd> for new line
      </p>
    </div>
  );
}
