import { memo, useContext, useState } from "react";
import { Square } from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { Avatar } from "@/components/ui/avatar";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { FileGrid } from "./fileView";
import { PathOpenContext, ResolveRefContext } from "./workspaceLink";
import { PermissionCard } from "./PermissionCard";
import { BotTracePanel } from "./BotTracePanel";
import { cancelMessage } from "@/api/messages";
import type { Message } from "@/types";

interface Props {
  message: Message;
  isConsecutive?: boolean;
  currentUserId?: string;
  channelId?: string;
  /** Channel-membership display label, used when the message has no sender_name. */
  senderName?: string;
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
  senderName,
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
  const name =
    message.sender_name || senderName || message.sender_id.slice(0, 8);
  const hasName = Boolean(message.sender_name || senderName);
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
          <MessageBody message={message} channelId={channelId} isBot={isBot} />
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
          <span
            className={cn("text-sm font-semibold text-zinc-100", isOwn && "order-2")}
            title={hasName ? undefined : message.sender_id}
          >
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
        <MessageBody message={message} channelId={channelId} isBot={isBot} />
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

/**
 * Per-message "Stop" control for an in-flight bot turn. Sends the ACP
 * `session/cancel` (POST …/messages/:id/cancel); the gateway gates it as an
 * INITIATE event (members allowed by default). We attach it to the bot's own
 * reply bubble rather than the composer, so each turn is cancelled in place.
 */
function StopButton({ channelId, msgId }: { channelId: string; msgId: string }) {
  const [stopping, setStopping] = useState(false);
  return (
    <button
      type="button"
      disabled={stopping}
      onClick={async () => {
        setStopping(true);
        try {
          await cancelMessage(channelId, msgId);
          // Leave it disabled: the turn finalizes via the stream and the bubble
          // drops out of its active state, unmounting this button.
        } catch (e) {
          const raw = e instanceof Error ? e.message : String(e);
          // A turn that already finished 404s ("not found") — a benign race, not
          // worth a toast. Surface anything else (e.g. a 403 authz denial).
          if (!/not found/i.test(raw)) {
            let detail = raw;
            try {
              detail = (JSON.parse(raw) as { detail?: string }).detail ?? raw;
            } catch {
              /* not JSON — use raw */
            }
            toast.error(detail);
          }
          setStopping(false);
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-zinc-100 disabled:opacity-50"
      title="Stop the agent's current turn"
    >
      <Square className="w-3 h-3" fill="currentColor" />
      {stopping ? "Stopping…" : "Stop"}
    </button>
  );
}

function MessageBody({
  message,
  channelId,
  isBot,
}: {
  message: Message;
  channelId?: string;
  isBot?: boolean;
}) {
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
        {isBot && channelId && (
          <StopButton channelId={channelId} msgId={message.msg_id} />
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
      {active && isBot && channelId && (
        <div className="mt-1">
          <StopButton channelId={channelId} msgId={message.msg_id} />
        </div>
      )}
      <FileGrid files={files} className="mt-1.5" />
    </div>
  );
}
