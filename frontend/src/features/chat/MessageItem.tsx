import { memo, useContext } from "react";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { Avatar } from "@/components/ui/avatar";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { FileGrid } from "./fileView";
import { PathOpenContext, ResolveRefContext } from "./workspaceLink";
import { PermissionCard } from "./PermissionCard";
import { BotTracePanel } from "./BotTracePanel";
import type { Message } from "@/types";

interface Props {
  message: Message;
  isConsecutive?: boolean;
  currentUserId?: string;
  channelId?: string;
}

const SYSTEM_TYPES = new Set([
  "routing",
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
  channelId,
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

  if (message.msg_type === "permission") {
    // Render inline in the bot's column (indented past the avatar gutter) so the
    // approval box reads as part of the bot's reply / trace rather than a
    // detached centered card.
    return (
      <div className="flex items-start gap-3 px-4 py-0.5">
        <div className="w-9 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <PermissionCard
            message={message}
            channelId={channelId}
            currentUserId={currentUserId}
          />
        </div>
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
          {isBot && channelId && !message._streaming && !message.is_partial && (
            <BotTracePanel
              key={`trace-${message.msg_id}`}
              channelId={channelId}
              msgId={message.msg_id}
            />
          )}
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
        {isBot && channelId && !message._streaming && !message.is_partial && (
          <BotTracePanel
            key={`trace-${message.msg_id}`}
            channelId={channelId}
            msgId={message.msg_id}
          />
        )}
      </div>
    </div>
  );
});

// Flat <#file:id> tokens render as chips (below), not inline text.
const FILE_TOKEN = /<#file:[^>]+>/g;

function MessageBody({ message }: { message: Message }) {
  const resolveRefClick = useContext(ResolveRefContext);
  // Bind a clicked reference to THIS message's bot + its own attachments, so the
  // resolver can prefer "a file this turn actually produced" and pick the right
  // store (multi-bot ambiguity resolved for free).
  const pathOpen =
    message.sender_type === "bot" && resolveRefClick
      ? (ref: string) =>
          resolveRefClick({ senderBotId: message.sender_id, ref, files: message.files })
      : null;
  const files = message.files ?? [];
  const content = (message.content ?? "").replace(FILE_TOKEN, "").trim();
  // Treat a pending bot placeholder (is_partial) as active too — the agent
  // trace + typing indicator must show during the "thinking" phase, which
  // happens before the first delta sets _streaming.
  const active = message._streaming || message.is_partial;

  if (active && !content && files.length === 0) {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
        </div>
        {message._trace && (
          <span className="text-xs text-zinc-500 italic truncate">
            {message._trace}
          </span>
        )}
      </div>
    );
  }

  if (message.error) {
    return <p className="text-sm text-red-400 italic">{message.error}</p>;
  }

  const hasMarkdown =
    content.includes("```") ||
    content.includes("**") ||
    content.includes("*") ||
    content.includes("#") ||
    content.includes("[") ||
    content.includes("\n") ||
    content.includes("`");

  return (
    <div className="relative">
      {content &&
        (hasMarkdown ? (
          <PathOpenContext.Provider value={pathOpen}>
            <MarkdownRenderer content={content} className="text-sm" />
          </PathOpenContext.Provider>
        ) : (
          <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </p>
        ))}
      {message._streaming && (
        <span className="inline-block w-0.5 h-4 bg-zinc-400 animate-blink ml-0.5 align-text-bottom" />
      )}
      {active && message._trace && (
        <p className="text-xs text-zinc-500 italic mt-0.5">{message._trace}</p>
      )}
      <FileGrid files={files} className="mt-1.5" />
    </div>
  );
}
