import { memo } from "react";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { Avatar } from "@/components/ui/avatar";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import type { Message } from "@/types";

interface Props {
  message: Message;
  isConsecutive?: boolean;
  currentUserId?: string;
}

const SYSTEM_TYPES = new Set([
  "routing",
  "permission",
  "announcement",
  "notification",
]);

function SystemMessage({ message }: { message: Message }) {
  return (
    <div className="flex items-center gap-3 py-1 px-4">
      <div className="flex-1 h-px bg-zinc-800" />
      <span className="text-xs text-zinc-500 whitespace-nowrap">
        {message.content}
      </span>
      <div className="flex-1 h-px bg-zinc-800" />
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  isConsecutive,
  currentUserId,
}: Props) {
  if (message.is_deleted) {
    return (
      <div className="px-4 py-0.5 flex items-center gap-3 group">
        {!isConsecutive && <div className="w-9 h-9 flex-shrink-0" />}
        {isConsecutive && <div className="w-9 flex-shrink-0" />}
        <span className="text-zinc-600 italic text-sm">
          This message was deleted
        </span>
      </div>
    );
  }

  if (message.msg_type && SYSTEM_TYPES.has(message.msg_type)) {
    return <SystemMessage message={message} />;
  }

  const isOwn = message.sender_id === currentUserId;
  const name = message.sender_name || message.sender_id.slice(0, 8);
  const isBot = message.sender_type === "bot";

  if (isConsecutive) {
    return (
      <div className="group flex items-start gap-3 px-4 py-0.5 hover:bg-zinc-900/40 transition-colors">
        <div className="w-9 flex-shrink-0 flex items-center justify-end pt-1">
          <span className="text-[10px] text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity select-none">
            {formatTime(message.created_at)}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <MessageBody message={message} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-start gap-3 px-4 py-1.5 hover:bg-zinc-900/40 transition-colors",
        isOwn && "flex-row-reverse"
      )}
    >
      {/* Avatar */}
      <Avatar
        name={name}
        src={undefined}
        id={message.sender_id}
        size="sm"
        className="mt-0.5 flex-shrink-0"
      />

      <div className={cn("flex-1 min-w-0", isOwn && "flex flex-col items-end")}>
        {/* Header */}
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className={cn("text-sm font-semibold text-zinc-100", isOwn && "order-2")}>
            {name}
          </span>
          {isBot && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300 font-medium">
              BOT
            </span>
          )}
          <span className="text-[11px] text-zinc-600 tabular-nums">
            {formatTime(message.created_at)}
          </span>
        </div>

        {/* Body */}
        <MessageBody message={message} />
      </div>
    </div>
  );
});

function MessageBody({ message }: { message: Message }) {
  if (message._streaming && !message.content) {
    return (
      <div className="flex items-center gap-1 py-1">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
      </div>
    );
  }

  if (message.error) {
    return (
      <p className="text-sm text-red-400 italic">{message.error}</p>
    );
  }

  const hasMarkdown =
    message.content.includes("```") ||
    message.content.includes("**") ||
    message.content.includes("*") ||
    message.content.includes("#") ||
    message.content.includes("[") ||
    message.content.includes("\n") ||
    message.content.includes("`");

  return (
    <div className="relative">
      {hasMarkdown ? (
        <MarkdownRenderer content={message.content} className="text-sm" />
      ) : (
        <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap break-words">
          {message.content}
        </p>
      )}
      {message._streaming && (
        <span className="inline-block w-0.5 h-4 bg-zinc-400 animate-blink ml-0.5 align-text-bottom" />
      )}
    </div>
  );
}
