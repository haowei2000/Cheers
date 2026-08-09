import { memo, useContext, useEffect, useRef, useState, type RefObject } from "react";
import {
  Square,
  MessageCircleMore,
  Copy,
  Forward,
  CheckSquare,
  Check,
  AlertCircle,
  RotateCw,
  Loader2,
  ListTree,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { Avatar } from "@/components/ui/avatar";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { FileGrid } from "./fileView";
import { MessageContextChips } from "./context/ContextPickBar";
import { PathOpenContext, ResolveRefContext } from "./workspaceLink";
import { PermissionCard } from "./PermissionCard";
import { AuthRequiredCard } from "./AuthRequiredCard";
import { TaskClaimConfirmationCard } from "./TaskClaimConfirmationCard";
import { BotTracePanel } from "./BotTracePanel";
import { stopTurn } from "./stopTurn";
import type { Message } from "@/types";
import { useProfileCard } from "./ProfileHovercard";
import { FloatingLayer } from "@/components/ui/floating-layer";
import { useHoverIntent } from "@/hooks/useHoverIntent";
import { messageDetailsMeta } from "./messageDetails";

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
  /** True when rendered as a sub-message under a parent (compact chrome). */
  nested?: boolean;
  /** Chat mirrors the current user's messages to the right; Discuss keeps all
   * participants on the left so the thread reads as one continuous document. */
  alignOwnMessages?: boolean;
  /** Parent is in the loaded window — skip the quote strip (parent is above). */
  hideReplyQuote?: boolean;
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
  /** Pending permission cards anchored to this bot turn (rendered in Agent steps). */
  pendingApprovals?: Message[];
  /** Deep-link into Agent steps Approval (from ViewBoard jump). */
  focusRequestId?: string | null;
}

const SYSTEM_TYPES = new Set([
  "routing",
  "announcement",
  "notification",
]);

function SystemMessage({ message }: { message: Message }) {
  return (
    <div className="flex justify-center py-3 px-4">
      <span className="text-xs text-zinc-400 whitespace-nowrap">
        {message.content}
      </span>
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
  anchorRef,
  visible,
  onEnter,
  onLeave,
  hasDetails,
  detailsExpanded,
  onToggleDetails,
}: {
  message: Message;
  actions: MessageActionHandlers;
  reversed?: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  visible: boolean;
  onEnter: () => void;
  onLeave: () => void;
  hasDetails?: boolean;
  detailsExpanded?: boolean;
  onToggleDetails?: () => void;
}) {
  const btn =
    "flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-700/70 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70";
  return (
    <FloatingLayer
      anchorRef={anchorRef}
      placement="up"
      align={reversed ? "start" : "end"}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className={cn(
        "flex items-center gap-0.5 rounded-lg border border-zinc-700/70 bg-zinc-800/95 p-0.5 shadow-xl shadow-black/30 backdrop-blur transition-opacity",
        visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      )}
    >
      {hasDetails && onToggleDetails && (
        <button
          type="button"
          title={detailsExpanded ? "Hide details" : "Show details"}
          aria-label={detailsExpanded ? "Hide message details" : "Show message details"}
          aria-expanded={detailsExpanded}
          className={btn}
          onClick={onToggleDetails}
        >
          <ListTree className="h-3.5 w-3.5" />
        </button>
      )}
      <button type="button" title="Reply" aria-label="Reply" className={btn} onClick={() => actions.onReply(message)}>
        <MessageCircleMore className="w-3.5 h-3.5" />
      </button>
      <button type="button" title="Copy text" aria-label="Copy text" className={btn} onClick={() => void copyMessage(message)}>
        <Copy className="w-3.5 h-3.5" />
      </button>
      <button type="button" title="Forward" aria-label="Forward" className={btn} onClick={() => actions.onForward(message)}>
        <Forward className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        title="Select (multi-select)"
        aria-label="Select message"
        className={btn}
        onClick={() => actions.onToggleSelect(message)}
      >
        <CheckSquare className="w-3.5 h-3.5" />
      </button>
    </FloatingLayer>
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

/** Discord-style source preview shown above a flat Chat reply. */
function ReplyPreview({
  message,
  repliedTo,
  nameOf,
  avatarUrl,
  reversed,
}: {
  message: Message;
  repliedTo?: Message | null;
  nameOf?: (senderId: string) => string;
  avatarUrl?: string;
  reversed?: boolean;
}) {
  if (!message.reply_to_msg_id) return null;
  const excerpt = repliedTo
    ? (repliedTo.content ?? "").replace(FILE_TOKEN_RE, "").trim().slice(0, 120) ||
      (repliedTo.files?.length ? "(attachment)" : "(empty message)")
    : "original message not in view";
  const who = repliedTo ? nameOf?.(repliedTo.sender_id) ?? repliedTo.sender_id.slice(0, 8) : "";
  const connector = (
    <span
      aria-hidden
      className={cn(
        "mt-2 h-4 w-8 flex-shrink-0 border-t border-zinc-700/80",
        reversed
          ? "ml-2 rounded-tr-lg border-r"
          : "mr-2 rounded-tl-lg border-l",
      )}
    />
  );
  const source = (
    <span className="flex min-w-0 items-center gap-1.5 py-0.5">
      {repliedTo && (
        <Avatar
          name={who}
          src={avatarUrl}
          id={repliedTo.sender_id}
          size="xs"
          className="h-4 w-4 text-[8px]"
        />
      )}
      {who && (
        <span className="flex-shrink-0 font-semibold text-zinc-300 group-hover/reply:text-zinc-100">
          {who}
        </span>
      )}
      <span className="truncate text-zinc-500 group-hover/reply:text-zinc-400">
        {excerpt}
      </span>
    </span>
  );

  const jumpToSource = () => {
    if (!repliedTo) return;
    document
      .querySelector<HTMLElement>(
        `[data-msg-id="${CSS.escape(repliedTo.msg_id)}"]`,
      )
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <button
      type="button"
      disabled={!repliedTo}
      onClick={jumpToSource}
      aria-label={repliedTo ? `Jump to message from ${who}` : undefined}
      className={cn(
        "group/reply -mb-0.5 flex max-w-full items-start text-left text-[11px] leading-5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70",
        repliedTo ? "cursor-pointer" : "cursor-default",
        reversed && "self-end",
      )}
      title={excerpt}
    >
      {reversed ? (
        <>
          {source}
          {connector}
        </>
      ) : (
        <>
          {connector}
          {source}
        </>
      )}
    </button>
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
  nested = false,
  alignOwnMessages = true,
  hideReplyQuote = false,
  currentUserId,
  channelId,
  senderName,
  actions,
  selectMode,
  selected: selectedProp,
  repliedTo,
  nameOf,
  pendingApprovals,
  focusRequestId,
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
    // Orphan permission cards (no source_msg_id) stay as their own row.
    // Anchored approvals render inside the source bot turn's Agent steps.
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

  if (message.msg_type === "auth_required") {
    return (
      <div className="flex items-start gap-3 px-4 py-0.5">
        <div className="w-9 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <AuthRequiredCard
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
  const isOwnAlignedRight = isOwn && alignOwnMessages && !nested;
  // Chat keeps the identity attached to the avatar so message content starts at
  // the top of the row. Discuss deliberately retains its document-style author
  // header above the body. `alignOwnMessages` is enabled only by the Chat layout.
  const showChatIdentityUnderAvatar = alignOwnMessages && !nested;
  const name =
    message.sender_name || senderName || message.sender_id.slice(0, 8);
  const hasName = Boolean(message.sender_name || senderName);
  const isBot = message.sender_type === "bot";
  const actionableApprovalCount = (pendingApprovals ?? []).filter(
    (approval) =>
      !(approval.content_data as { resolved?: boolean } | null | undefined)?.resolved,
  ).length;
  const detailsMeta = messageDetailsMeta(message, actionableApprovalCount);
  const [detailsExpanded, setDetailsExpanded] = useState(
    actionableApprovalCount > 0 || Boolean(focusRequestId),
  );

  useEffect(() => {
    if (actionableApprovalCount > 0 || focusRequestId) setDetailsExpanded(true);
  }, [actionableApprovalCount, focusRequestId]);

  const active = message._streaming || message.is_partial;
  // Agent steps only exist when the list DTO or live frame proves that content
  // exists. This prevents empty completed bot turns from showing disclosure
  // chrome such as "Agent steps · 0".
  const showTrace =
    isBot &&
    !!channelId &&
    detailsMeta.hasTrace;
  const tracePanel = showTrace ? (
    <BotTracePanel
      key={`trace-${message.msg_id}`}
      channelId={channelId!}
      msgId={message.msg_id}
      liveEvents={message._trace_events}
      pendingApprovals={pendingApprovals}
      currentUserId={currentUserId}
      streaming={!!active}
      focusRequestId={focusRequestId}
      expanded={detailsExpanded}
      onExpandedChange={setDetailsExpanded}
      showToggle={false}
    />
  ) : null;
  // A failed/sending placeholder isn't a real server message — no reply/forward/select.
  const showActions = actions && !active && !selectMode && !message._status;
  const selectable = Boolean(actions && selectMode);
  const rowRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Delayed hide (not instant setState-on-leave) so the bar survives the gap
  // between the row and the floating toolbar while the cursor crosses it —
  // see useHoverIntent.
  const { visible: actionsVisible, show: showActionBar, hide: hideActionBar } = useHoverIntent();

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
  // Discuss already expresses the relationship through nesting and its connector
  // rail. Chat and orphan replies use the compact, clickable source preview.
  const quote = hideReplyQuote ? null : (
    <ReplyPreview
      message={message}
      repliedTo={repliedTo}
      nameOf={nameOf}
      avatarUrl={
        repliedTo
          ? profileCard?.memberOf(repliedTo.sender_id)?.avatar_url ?? undefined
          : undefined
      }
      reversed={isOwnAlignedRight}
    />
  );
  const detailsSummary = [
    detailsMeta.traceCount > 0
      ? `${detailsMeta.traceCount} step${detailsMeta.traceCount === 1 ? "" : "s"}`
      : null,
    detailsMeta.contextCount > 0
      ? `${detailsMeta.contextCount} context${detailsMeta.contextCount === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean).join(" · ");
  const detailsSection = detailsMeta.hasDetails ? (
    <div className={cn("flex max-w-full flex-col", isOwnAlignedRight && "items-end")}>
      {detailsMeta.hasFailure && (
        <div role="alert" className="flex min-h-8 items-center gap-1.5 text-[11px] text-red-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Agent step failed</span>
          {!detailsExpanded && (
            <button
              type="button"
              onClick={() => setDetailsExpanded(true)}
              className="font-medium text-red-300 underline underline-offset-2 hover:text-red-200"
            >
              View details
            </button>
          )}
        </div>
      )}
      {actionableApprovalCount === 0 && (
        <button
          type="button"
          onClick={() => setDetailsExpanded((value) => !value)}
          aria-expanded={detailsExpanded}
          className="relative inline-flex h-8 items-center gap-1.5 self-start rounded-md px-1.5 text-[11px] text-zinc-400 transition-colors after:absolute after:-inset-y-1.5 after:inset-x-0 hover:bg-zinc-800/60 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70"
        >
          {detailsExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <span className="font-medium">Details</span>
          {detailsSummary && <span className="text-zinc-500">· {detailsSummary}</span>}
        </button>
      )}
      {detailsExpanded && (
        <div className="mt-1 flex w-full min-w-0 flex-col gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/30 px-3 py-2.5 text-left md:min-w-[18rem]">
          {detailsMeta.contextCount > 0 && (
            <section aria-label="Referenced context">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Context · {detailsMeta.contextCount}
              </p>
              <MessageContextChips bundle={message.context_bundle} />
            </section>
          )}
          {showTrace && (
            <section aria-label="Agent steps">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Agent steps · {detailsMeta.traceCount}
              </p>
              {tracePanel}
            </section>
          )}
        </div>
      )}
    </div>
  ) : null;
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

  if (isConsecutive || nested) {
    return (
      <div
        className={cn(
          "group relative flex items-start gap-3 rounded-lg transition-colors hover:z-20 focus-within:z-20",
          nested
            ? "w-full bg-zinc-900/20 px-2.5 py-2 hover:bg-zinc-900/50 md:w-fit md:max-w-[56rem]"
            : "mx-2 px-3 py-1 hover:bg-zinc-900/45 md:mx-4 md:px-4",
          isOwnAlignedRight && "flex-row-reverse",
          selectable && "cursor-pointer",
          selected && "bg-indigo-950/30 hover:bg-indigo-950/40",
        )}
        {...rowSelectProps}
        ref={rowRef}
        onMouseEnter={showActionBar}
        onMouseLeave={hideActionBar}
        onFocusCapture={showActionBar}
      >
        {selectable && (
          <SelectBox
            selected={selected}
            className={isOwnAlignedRight ? "order-last" : undefined}
          />
        )}
        {!nested && (
          <div className="w-9 flex-shrink-0 flex items-center justify-end pt-1">
            <span className="whitespace-nowrap text-[10px] tabular-nums text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 select-none">
              {formatTime(message.created_at)}
            </span>
          </div>
        )}
        {nested && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openProfile(e.currentTarget);
            }}
            className="mt-0.5 w-7 flex-shrink-0 rounded-full hover:opacity-80 transition-opacity"
            title="View profile"
          >
            <Avatar
              name={name}
              src={profileCard?.memberOf(message.sender_id)?.avatar_url ?? undefined}
              id={message.sender_id}
              size="xs"
            />
          </button>
        )}
        {/* Tight gap: body ↔ status ↔ Agent steps within one message. */}
        <div
          ref={contentRef}
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-1.5 md:flex-none md:w-fit md:max-w-[52rem]",
            isOwnAlignedRight && "items-end",
          )}
        >
          {nested && (
            <div className="flex items-baseline gap-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openProfile(e.currentTarget);
                }}
                className="text-[11px] font-medium text-zinc-300 hover:underline truncate"
              >
                {name}
              </button>
              {isBot && (
                <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300 font-medium">
                  BOT
                </span>
              )}
              <span className="text-[10px] text-zinc-500 tabular-nums">
                {formatTime(message.created_at)}
              </span>
            </div>
          )}
          {quote}
          <MessageBody message={message} channelId={channelId} isBot={isBot} />
          {message.msg_type === "task_claim_confirmation" && (
            <TaskClaimConfirmationCard
              message={message}
              channelId={channelId}
              currentUserId={currentUserId}
            />
          )}
          {message._status && (
            <SendStatus message={message} onRetry={actions?.onRetry} />
          )}
          {detailsSection}
        </div>
        {showActions && (
          <ActionBar
            message={message}
            actions={actions}
            reversed={isOwnAlignedRight}
            anchorRef={contentRef}
            visible={actionsVisible}
            onEnter={showActionBar}
            onLeave={hideActionBar}
            hasDetails={detailsMeta.hasDetails}
            detailsExpanded={detailsExpanded}
            onToggleDetails={() => setDetailsExpanded((value) => !value)}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative mx-2 flex items-start gap-3 rounded-xl px-3 py-2 transition-colors hover:z-20 hover:bg-zinc-900/45 focus-within:z-20 md:mx-4 md:px-4",
        isOwnAlignedRight && "flex-row-reverse",
        selectable && "cursor-pointer",
        selected && "bg-indigo-950/30 hover:bg-indigo-950/40",
      )}
      {...rowSelectProps}
      ref={rowRef}
      onMouseEnter={showActionBar}
      onMouseLeave={hideActionBar}
      onFocusCapture={showActionBar}
    >
      {/* order-last on reversed (own) rows keeps the checkbox column visually left. */}
      {selectable && (
        <SelectBox selected={selected} className={isOwnAlignedRight ? "order-last" : undefined} />
      )}
      {/* Chat puts compact identity metadata below the avatar; Discuss keeps its
          author header beside the avatar so the topic remains document-like. */}
      <button
        type="button"
        onClick={(e) => openProfile(e.currentTarget)}
        className={cn(
          "mt-0.5 flex-shrink-0 rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70",
          showChatIdentityUnderAvatar && "flex w-14 flex-col items-center gap-0.5",
        )}
        title={hasName ? name : message.sender_id}
        aria-label={`View profile for ${name}`}
      >
        <Avatar
          name={name}
          src={profileCard?.memberOf(message.sender_id)?.avatar_url ?? undefined}
          id={message.sender_id}
          size="sm"
        />
        {showChatIdentityUnderAvatar && (
          <>
            <span className="mt-0.5 block w-full truncate text-center text-[10px] font-medium leading-3 text-zinc-400">
              {name}
            </span>
            <span className="flex items-center justify-center gap-1 whitespace-nowrap text-[9px] leading-3 text-zinc-500">
              {isBot && (
                <span className="font-semibold uppercase tracking-wide text-indigo-400">
                  Bot
                </span>
              )}
              <span className="tabular-nums">
                {formatTime(message.created_at)}
              </span>
            </span>
          </>
        )}
      </button>

      {/* Tight gap: header/body ↔ status ↔ Agent steps within one message. */}
      <div
        ref={contentRef}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-1.5 md:flex-none md:w-fit md:max-w-[52rem]",
          isOwnAlignedRight && "items-end",
        )}
      >
        {quote}
        {!showChatIdentityUnderAvatar && (
          <div className={cn("flex items-center gap-2", isOwnAlignedRight && "flex-row-reverse")}>
            <button
              type="button"
              onClick={(e) => openProfile(e.currentTarget)}
              className="text-sm font-semibold text-zinc-100 hover:underline"
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
        )}

        <MessageBody message={message} channelId={channelId} isBot={isBot} />
        {message.msg_type === "task_claim_confirmation" && (
          <TaskClaimConfirmationCard
            message={message}
            channelId={channelId}
            currentUserId={currentUserId}
          />
        )}
        {message._status && (
          <SendStatus message={message} onRetry={actions?.onRetry} />
        )}
        {detailsSection}
      </div>
      {showActions && (
        <ActionBar
          message={message}
          actions={actions}
          reversed={isOwnAlignedRight}
          anchorRef={contentRef}
          visible={actionsVisible}
          onEnter={showActionBar}
          onLeave={hideActionBar}
          hasDetails={detailsMeta.hasDetails}
          detailsExpanded={detailsExpanded}
          onToggleDetails={() => setDetailsExpanded((value) => !value)}
        />
      )}
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

  // While a bubble is streaming, re-parsing the whole accumulated Markdown +
  // re-highlighting the growing code block every animation frame is ~O(len^2)
  // main-thread work. Render the in-flight text as plain whitespace-pre-wrap and
  // only switch to full Markdown + highlighting once the turn finalizes
  // (_streaming clears), which leaves completed messages rendered exactly as before.
  const hasMarkdown =
    !message._streaming &&
    (content.includes("```") ||
      content.includes("**") ||
      content.includes("*") ||
      content.includes("#") ||
      content.includes("[") ||
      content.includes("\n") ||
      content.includes("`"));

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
      <FileGrid files={files} className="mt-1" />
    </div>
  );
}
