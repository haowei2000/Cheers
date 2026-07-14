import { memo, useContext, useState } from "react";
import { Square, MessageCircleMore, Reply, Copy, Forward, CheckSquare, Check, AlertCircle, RotateCw, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { Avatar } from "@/components/ui/avatar";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { FileGrid } from "./fileView";
import { PathOpenContext, ResolveRefContext } from "./workspaceLink";
import { PermissionCard } from "./PermissionCard";
import { BotTracePanel } from "./BotTracePanel";
import { stopTurn } from "./stopTurn";
import type { Message } from "@/types";
import { useProfileCard } from "./ProfileHovercard";

/** Per-message action callbacks. Identity must be STABLE across selection
 *  changes — selection state travels as the scalar `selectMode`/`selected`
 *  props so memo() only re-renders the rows whose bits actually changed. */
export interface MessageActionHandlers {
  onReply: (m: Message) => void;
  onForward: (m: Message) => void;
  /** Toggle this message in the multi-select set (entering select mode if off). */
  onToggleSelect: (m: Message) => void;
  /** Re-send a message whose send failed (client-only `_status: "failed"`). */
  onRetry?: (m: Message) => void;
}

interface Props {
  message: Message;
  isConsecutive?: boolean;
  currentUserId?: string;
  channelId?: string;
  /** Channel-membership display label, used when the message has no sender_name. */
  senderName?: string;
  actions?: MessageActionHandlers;
  selectMode?: boolean;
  selected?: boolean;
  /** The message this one replies to (resolved from the loaded window), if any. */
  repliedTo?: Message | null;
  /** Display name resolver for the reply-quote header. */
  nameOf?: (senderId: string) => string;
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
      <span className="text-xs text-zinc-400 whitespace-nowrap">
        {message.content}
      </span>
      <div className="flex-1 h-px bg-zinc-800" />
    </div>
  );
}

// Flat <#file:id> tokens render as chips, not inline text (also stripped on copy).
const FILE_TOKEN_RE = /<#file:[^>]+>/g;

/** Copy a message's visible text to the clipboard. */
async function copyMessage(message: Message) {
  const text = (message.content ?? "").replace(FILE_TOKEN_RE, "").trim();
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Clipboard unavailable");
  }
}

/** Hover toolbar: reply · copy · forward · select. Hidden while streaming.
 *  `reversed` rows (own messages) put the header on the right, so the toolbar
 *  anchors left to avoid overlapping the name/timestamp/avatar. */
function ActionBar({
  message,
  actions,
  reversed,
}: {
  message: Message;
  actions: MessageActionHandlers;
  reversed?: boolean;
}) {
  const btn =
    "flex items-center justify-center w-7 h-7 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/70";
  return (
    <div
      className={cn(
        "absolute -top-3 z-10 flex opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto items-center gap-1 rounded-lg bg-zinc-800 px-1 py-0.5 shadow-lg transition-opacity",
        reversed ? "left-4" : "right-4"
      )}
    >
      <button type="button" title="Reply" className={btn} onClick={() => actions.onReply(message)}>
        <MessageCircleMore className="w-3.5 h-3.5" />
      </button>
      <button type="button" title="Copy text" className={btn} onClick={() => void copyMessage(message)}>
        <Copy className="w-3.5 h-3.5" />
      </button>
      <button type="button" title="Forward" className={btn} onClick={() => actions.onForward(message)}>
        <Forward className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        title="Select (multi-select)"
        className={btn}
        onClick={() => actions.onToggleSelect(message)}
      >
        <CheckSquare className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/** Delivery status shown under an own message that isn't server-confirmed yet:
 *  a spinner while a retry is in flight, or a "Failed to send · Retry" affordance. */
function SendStatus({
  message,
  onRetry,
}: {
  message: Message;
  onRetry?: (m: Message) => void;
}) {
  if (message._status === "sending") {
    return (
      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-400">
        <Loader2 className="w-3 h-3 animate-spin" />
        Sending…
      </div>
    );
  }
  return (
    <div role="alert" className="mt-0.5 flex items-center gap-1.5 text-[11px] text-red-400">
      <AlertCircle className="w-3 h-3 flex-shrink-0" />
      <span>Failed to send</span>
      {onRetry && (
        <button
          type="button"
          onClick={() => onRetry(message)}
          className="inline-flex items-center gap-0.5 font-medium text-red-300 underline underline-offset-2 hover:text-red-200"
        >
          <RotateCw className="w-3 h-3" />
          Retry
        </button>
      )}
    </div>
  );
}

/** Quote block shown above a reply's body, linking it to the original. */
function ReplyQuote({
  message,
  repliedTo,
  nameOf,
}: {
  message: Message;
  repliedTo?: Message | null;
  nameOf?: (senderId: string) => string;
}) {
  if (!message.reply_to_msg_id) return null;
  const excerpt = repliedTo
    ? (repliedTo.content ?? "").replace(FILE_TOKEN_RE, "").trim().slice(0, 120) ||
      (repliedTo.files?.length ? "(attachment)" : "(empty message)")
    : "original message not in view";
  const who = repliedTo ? nameOf?.(repliedTo.sender_id) ?? repliedTo.sender_id.slice(0, 8) : "";
  return (
    <div className="flex items-center gap-1.5 mb-0.5 pl-2 border-l-2 border-zinc-700 text-[11px] text-zinc-400 max-w-full">
      <Reply className="w-3 h-3 flex-shrink-0 rotate-180" />
      {who && <span className="font-medium text-zinc-400 flex-shrink-0">{who}</span>}
      <span className="truncate italic">{excerpt}</span>
    </div>
  );
}

/** In select mode: leading checkbox column; whole row click toggles.
 *  `className` lets the own-message (flex-row-reverse) row pin it visually
 *  left via `order-last` so the selection column never flips sides. */
function SelectBox({ selected, className }: { selected: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center w-4 h-4 mt-1.5 rounded border flex-shrink-0",
        selected ? "bg-indigo-600 border-indigo-500" : "border-zinc-600",
        className
      )}
    >
      {selected && <Check className="w-3 h-3 text-white" />}
    </span>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  isConsecutive,
  currentUserId,
  channelId,
  senderName,
  actions,
  selectMode,
  selected: selectedProp,
  repliedTo,
  nameOf,
}: Props) {
  if (message.is_deleted) {
    return (
      <div className="px-4 py-0.5 flex items-center gap-3 group">
        {!isConsecutive && <div className="w-9 h-9 flex-shrink-0" />}
        {isConsecutive && <div className="w-9 flex-shrink-0" />}
        <span className="text-zinc-400 italic text-sm">
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

  const active = message._streaming || message.is_partial;
  // A failed/sending placeholder isn't a real server message — no reply/forward/select.
  const showActions = actions && !active && !selectMode && !message._status;
  const selectable = Boolean(actions && selectMode);

  // Click the sender's avatar/name → open their profile card (bio/status). In
  // select mode the row-click owns the interaction, so skip it there.
  const profileCard = useProfileCard();
  const openProfile = (anchor: HTMLElement) => {
    if (selectable) return;
    profileCard?.openById(anchor, message.sender_id, {
      display_name: message.sender_name ?? name,
      member_type: message.sender_type,
    });
  };
  const selected = Boolean(selectedProp);
  const rowSelectProps = selectable
    ? {
        onClick: (e: React.MouseEvent) => {
          // Don't hijack clicks meant for inner controls (Stop, links, file chips):
          // only toggle when the click landed on non-interactive row content.
          if ((e.target as HTMLElement).closest("button, a")) return;
          actions?.onToggleSelect(message);
        },
        onKeyDown: (e: React.KeyboardEvent) => {
          // The row is announced as role="checkbox"; make it keyboard-operable —
          // Space/Enter toggles it. Ignore keys bubbling from inner controls.
          if (e.key !== " " && e.key !== "Enter") return;
          if ((e.target as HTMLElement).closest("button, a")) return;
          e.preventDefault();
          actions?.onToggleSelect(message);
        },
        role: "checkbox" as const,
        "aria-checked": selected,
        tabIndex: 0,
      }
    : {};

  if (isConsecutive) {
    return (
      <div
        className={cn(
          "group relative flex items-start gap-3 px-4 py-0.5 hover:bg-zinc-900/40 transition-colors",
          selectable && "cursor-pointer",
          selected && "bg-indigo-950/30 hover:bg-indigo-950/40"
        )}
        {...rowSelectProps}
      >
        {selectable && <SelectBox selected={selected} />}
        <div className="w-9 flex-shrink-0 flex items-center justify-end pt-1">
          <span className="text-[11px] text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity select-none">
            {formatTime(message.created_at)}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <ReplyQuote message={message} repliedTo={repliedTo} nameOf={nameOf} />
          <MessageBody message={message} channelId={channelId} isBot={isBot} />
          {message._status && (
            <SendStatus message={message} onRetry={actions?.onRetry} />
          )}
          {isBot && channelId && !message._streaming && !message.is_partial && (
            <BotTracePanel
              key={`trace-${message.msg_id}`}
              channelId={channelId}
              msgId={message.msg_id}
            />
          )}
        </div>
        {showActions && <ActionBar message={message} actions={actions} />}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex items-start gap-3 px-4 py-1.5 hover:bg-zinc-900/40 transition-colors",
        isOwn && "flex-row-reverse",
        selectable && "cursor-pointer",
        selected && "bg-indigo-950/30 hover:bg-indigo-950/40"
      )}
      {...rowSelectProps}
    >
      {/* order-last on reversed (own) rows keeps the checkbox column visually left. */}
      {selectable && <SelectBox selected={selected} className={isOwn ? "order-last" : undefined} />}
      {/* Avatar — click to open the sender's profile card */}
      <button
        type="button"
        onClick={(e) => openProfile(e.currentTarget)}
        className="mt-0.5 flex-shrink-0 rounded-full hover:opacity-80 transition-opacity"
        title="View profile"
      >
        {/* avatar_url resolves via the profile-card member map (live-updated);
            fallback is the brand glyph for known agents, then initials. */}
        <Avatar
          name={name}
          src={profileCard?.memberOf(message.sender_id)?.avatar_url ?? undefined}
          id={message.sender_id}
          size="sm"
        />
      </button>

      <div className={cn("flex-1 min-w-0", isOwn && "flex flex-col items-end")}>
        {/* Header */}
        <div className="flex items-baseline gap-2 mb-0.5">
          <button
            type="button"
            onClick={(e) => openProfile(e.currentTarget)}
            className={cn(
              "text-sm font-semibold text-zinc-100 hover:underline",
              isOwn && "order-2"
            )}
            title={hasName ? "View profile" : message.sender_id}
          >
            {name}
          </button>
          {isBot && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300 font-medium">
              BOT
            </span>
          )}
          <span className="text-[11px] text-zinc-400 tabular-nums">
            {formatTime(message.created_at)}
          </span>
        </div>

        {/* Body */}
        <ReplyQuote message={message} repliedTo={repliedTo} nameOf={nameOf} />
        <MessageBody message={message} channelId={channelId} isBot={isBot} />
        {message._status && (
          <SendStatus message={message} onRetry={actions?.onRetry} />
        )}
        {isBot && channelId && !message._streaming && !message.is_partial && (
          <BotTracePanel
            key={`trace-${message.msg_id}`}
            channelId={channelId}
            msgId={message.msg_id}
          />
        )}
      </div>
      {showActions && <ActionBar message={message} actions={actions} reversed={isOwn} />}
    </div>
  );
});

/**
 * Per-message "Stop" control for an in-flight bot turn. Sends the ACP
 * `session/cancel` (POST …/messages/:id/cancel); the gateway gates it as an
 * INITIATE event (members allowed by default). We attach it to the bot's own
 * reply bubble rather than the composer, so each turn is cancelled in place.
 *
 * When the turn is part of a bot@bot cascade, the gateway stops the WHOLE chain
 * (DECENTRALIZED_MESH §8): it marks the chain cancelled so the dispatch gate
 * blocks any un-launched hops, and fans the cancel out to every in-flight bot in
 * it — one ⏹ halts the runaway, not just this bubble.
 */
function StopButton({ channelId, msgId }: { channelId: string; msgId: string }) {
  const [stopping, setStopping] = useState(false);
  return (
    <button
      type="button"
      disabled={stopping}
      onClick={async () => {
        setStopping(true);
        // On success leave it disabled: the turn finalizes via the stream and
        // the bubble drops out of its active state, unmounting this button.
        const ok = await stopTurn(channelId, msgId);
        if (!ok) setStopping(false);
      }}
      className="inline-flex items-center gap-1 rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-50"
      title="Stop this turn — and any bot-to-bot chain it started"
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
  const content = (message.content ?? "").replace(FILE_TOKEN_RE, "").trim();
  // Treat a pending bot placeholder (is_partial) as active too — the agent
  // trace + typing indicator must show during the "thinking" phase, which
  // happens before the first delta sets _streaming.
  const active = message._streaming || message.is_partial;

  if (active && !content && files.length === 0) {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce motion-reduce:animate-none [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce motion-reduce:animate-none [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce motion-reduce:animate-none [animation-delay:300ms]" />
        </div>
        {message._trace && (
          <span className="text-xs text-zinc-400 italic truncate">
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
        <span className="inline-block w-0.5 h-4 bg-zinc-400 animate-blink motion-reduce:animate-none ml-0.5 align-text-bottom" />
      )}
      {active && message._trace && (
        <p className="text-xs text-zinc-400 italic mt-0.5">{message._trace}</p>
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
