import { Button as UiButton } from "@/components/ui/button";
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
  AtSign,
  UserRound,
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { FileGrid } from "./fileView";
import { PathOpenContext, ResolveRefContext } from "./workspaceLink";
import { PermissionCard } from "./PermissionCard";
import { AuthRequiredCard } from "./AuthRequiredCard";
import { TaskClaimConfirmationCard } from "./TaskClaimConfirmationCard";
import { BotTracePanel } from "./BotTracePanel";
import { stopTurn } from "./stopTurn";
import type { Message } from "@/types";
import { useProfileCard } from "./ProfileHovercard";
import { FloatingLayer } from "@/components/ui/floating-layer";
import { IconButton } from "@/components/ui/icon-button";
import { controlIconClasses, controlTextClasses } from "@/components/ui/control-size";
import { useHoverIntent } from "@/hooks/useHoverIntent";
import { messageDetailsMeta } from "./messageDetails";
import { usePresentationLevel } from "@/components/ui/presentation";
import { MessageRecordInspector } from "./MessageRecordInspector";
import { identityRailWidthClasses } from "@/components/ui/content-size";

/** Per-message action callbacks. Identity must be STABLE across selection
 *  changes — selection state travels as the scalar `selectMode`/`selected`
 *  props so memo() only re-renders the rows whose bits actually changed. */
export interface MessageActionHandlers {
  onReply: (m: Message) => void;
  onForward: (m: Message) => void;
  /** Insert this sender as a picked composer mention. Never sends. */
  onMention?: (m: Message) => void;
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
      <span className="text-compact text-zinc-400 whitespace-nowrap">
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
 *  The toolbar's right edge follows the message content so it always expands
 *  leftward and remains reachable beside right-aligned own messages. */
function ActionBar({
  message,
  actions,
  anchorRef,
  visible,
  onEnter,
  onLeave,
  hasDetails,
  onOpenDetails,
  canMention,
  mentionLabel,
}: {
  message: Message;
  actions: MessageActionHandlers;
  anchorRef: RefObject<HTMLElement | null>;
  visible: boolean;
  onEnter: () => void;
  onLeave: () => void;
  hasDetails?: boolean;
  onOpenDetails?: (trigger: HTMLElement) => void;
  canMention?: boolean;
  mentionLabel?: string;
}) {
  const actionClass =
    "text-zinc-400 hover:bg-zinc-700/70 hover:text-zinc-100 focus-visible:ring-indigo-500/70";
  return (
    <FloatingLayer
      anchorRef={anchorRef}
      placement="up"
      align="end"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className={cn(
        "flex items-center gap-0.5 rounded-sm  border-zinc-700/70 bg-zinc-800/95 p-0.5 shadow-xl shadow-black/30 backdrop-blur transition-opacity",
        visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      )}
    >
      {hasDetails && onOpenDetails && (
        <IconButton
          label="Open message record"
          controlSize="regular"
          className={actionClass}
          onClick={(event) => onOpenDetails(event.currentTarget)}
        >
          <ListTree className={controlIconClasses.regular} />
        </IconButton>
      )}
      {canMention && actions.onMention && (
        <IconButton
          label={`Mention ${mentionLabel ?? "member"}`}
          title={`Mention @${mentionLabel ?? "member"}`}
          controlSize="regular"
          className={actionClass}
          onClick={() => actions.onMention?.(message)}
        >
          <AtSign className={controlIconClasses.regular} />
        </IconButton>
      )}
      <IconButton label="Reply" controlSize="regular" className={actionClass} onClick={() => actions.onReply(message)}>
        <MessageCircleMore className={controlIconClasses.regular} />
      </IconButton>
      <IconButton label="Copy text" controlSize="regular" className={actionClass} onClick={() => void copyMessage(message)}>
        <Copy className={controlIconClasses.regular} />
      </IconButton>
      <IconButton label="Forward" controlSize="regular" className={actionClass} onClick={() => actions.onForward(message)}>
        <Forward className={controlIconClasses.regular} />
      </IconButton>
      <IconButton
        label="Select message"
        title="Select (multi-select)"
        controlSize="regular"
        className={actionClass}
        onClick={() => actions.onToggleSelect(message)}
      >
        <CheckSquare className={controlIconClasses.regular} />
      </IconButton>
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
      <div className={cn("mt-0.5 flex items-center gap-1 text-zinc-400", controlTextClasses.compact)}>
        <Loader2 className="w-3 h-3 animate-spin" />
        Sending…
      </div>
    );
  }
  return (
    <div role="alert" className={cn("mt-0.5 flex items-center gap-1.5 text-red-400", controlTextClasses.compact)}>
      <AlertCircle className="w-3 h-3 flex-shrink-0" />
      <span>Failed to send</span>
      {onRetry && (
        <UiButton variant="plain"
          type="button"
          onClick={() => onRetry(message)}
          className="inline-flex items-center gap-0.5 font-medium text-red-300 underline underline-offset-2 hover:text-red-200"
        >
          <RotateCw className="w-3 h-3" />
          Retry
        </UiButton>
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
          ? "ml-2 rounded-tr-sm border-r"
          : "mr-2 rounded-tl-sm border-l",
      )}
    />
  );
  const source = (
    <span className="flex min-w-0 items-center gap-2 py-0.5">
      {repliedTo && who && (
        <span className="flex max-w-[45%] shrink-0 items-center gap-1.5 text-indigo-300 transition-colors group-hover/reply:text-indigo-200">
          <Avatar
            name={who}
            src={avatarUrl}
            id={repliedTo.sender_id}
            size="small"
            className="shrink-0"
          />
          <span className="truncate font-semibold">@{who}</span>
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
    <UiButton variant="plain"
      type="button"
      controlWidth="fill"
      controlSize="regular"
      disabled={!repliedTo}
      onClick={jumpToSource}
      aria-label={repliedTo ? `Jump to message from ${who}` : undefined}
      className={cn(
 "group/reply -mb-0.5 flex max-w-full items-start text-left leading-5",
 controlTextClasses.compact,
 "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70",
 repliedTo ? "cursor-pointer": "cursor-default",
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
    </UiButton>
  );
}

/** In select mode: leading checkbox column; whole row click toggles.
 *  `className` lets the own-message (flex-row-reverse) row pin it visually
 *  left via `order-last` so the selection column never flips sides. */
function SelectBox({ selected, className }: { selected: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center w-4 h-4 mt-1.5 rounded-sm  flex-shrink-0",
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
  const presentationLevel = usePresentationLevel();
  if (message.is_deleted) {
    return (
      <div data-item-kind="conversation" data-presentation-level={presentationLevel} className="px-4 py-0.5 flex items-center gap-3 group">
        {!isConsecutive && <div className="w-9 h-9 flex-shrink-0" />}
        {isConsecutive && <div className="w-9 flex-shrink-0" />}
        <span className="text-zinc-400 italic text-regular">
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
  const name =
    message.sender_name || senderName || message.sender_id.slice(0, 8);
  const hasName = Boolean(message.sender_name || senderName);
  const isBot = message.sender_type === "bot";
  const actionableApprovalCount = (pendingApprovals ?? []).filter(
    (approval) =>
      !(approval.content_data as { resolved?: boolean } | null | undefined)?.resolved,
  ).length;
  const detailsMeta = messageDetailsMeta(message, actionableApprovalCount);
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(focusRequestId));
  const inspectorTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (focusRequestId) setInspectorOpen(true);
  }, [focusRequestId]);

  const active = message._streaming || message.is_partial;
  // Agent steps only exist when the list DTO or live frame proves that content
  // exists. This prevents empty completed bot turns from showing disclosure
  // chrome such as "Agent steps · 0".
  const showTrace =
    isBot &&
    !!channelId &&
    detailsMeta.hasTrace;
  const keepTraceInline = Boolean(active || actionableApprovalCount > 0);
  const tracePanel = showTrace && keepTraceInline ? (
    <BotTracePanel
      key={`trace-${message.msg_id}`}
      channelId={channelId!}
      msgId={message.msg_id}
      liveEvents={message._trace_events}
      pendingApprovals={pendingApprovals}
      currentUserId={currentUserId}
      streaming={!!active}
      focusRequestId={focusRequestId}
      expanded
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
  const openInspector = (trigger: HTMLElement) => {
    inspectorTriggerRef.current = trigger;
    setInspectorOpen(true);
  };

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
  const canMention = Boolean(
    actions?.onMention && !isOwn && !selectMode && !message._status,
  );
  const avatarRef = useRef<HTMLButtonElement>(null);
  const profileClickTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressAvatarClickRef = useRef(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);

  const clearProfileClickTimer = () => {
    if (profileClickTimerRef.current !== null) {
      window.clearTimeout(profileClickTimerRef.current);
      profileClickTimerRef.current = null;
    }
  };
  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  };
  const mentionSender = () => {
    if (!canMention) return;
    clearProfileClickTimer();
    profileCard?.close();
    setAvatarMenuOpen(false);
    actions?.onMention?.(message);
  };
  const handleAvatarClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (suppressAvatarClickRef.current) {
      suppressAvatarClickRef.current = false;
      event.preventDefault();
      return;
    }
    if (!canMention || event.detail === 0) {
      openProfile(event.currentTarget);
      return;
    }
    clearProfileClickTimer();
    const anchor = event.currentTarget;
    profileClickTimerRef.current = window.setTimeout(() => {
      profileClickTimerRef.current = null;
      openProfile(anchor);
    }, 240);
  };
  const handleAvatarDoubleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!canMention) return;
    event.preventDefault();
    event.stopPropagation();
    mentionSender();
  };
  const handleAvatarPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!canMention || event.pointerType === "mouse") return;
    clearLongPressTimer();
    longPressStartRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      suppressAvatarClickRef.current = true;
      setAvatarMenuOpen(true);
      navigator.vibrate?.(10);
      window.setTimeout(() => {
        // Some mobile browsers do not synthesize the click that normally
        // follows pointer-up after a long press. Never suppress a later tap.
        suppressAvatarClickRef.current = false;
      }, 800);
    }, 500);
  };
  const handleAvatarPointerMove = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    const start = longPressStartRef.current;
    if (!start) return;
    if (
      Math.abs(event.clientX - start.x) > 10 ||
      Math.abs(event.clientY - start.y) > 10
    ) {
      clearLongPressTimer();
    }
  };
  const handleAvatarContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    if (!canMention) return;
    event.preventDefault();
    event.stopPropagation();
    clearProfileClickTimer();
    setAvatarMenuOpen(true);
  };

  useEffect(
    () => () => {
      if (profileClickTimerRef.current !== null) {
        window.clearTimeout(profileClickTimerRef.current);
      }
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!avatarMenuOpen) return;
    const dismiss = () => setAvatarMenuOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [avatarMenuOpen]);

  const avatarInteractionProps = {
    ref: avatarRef,
    onClick: handleAvatarClick,
    onDoubleClick: handleAvatarDoubleClick,
    onPointerDown: handleAvatarPointerDown,
    onPointerMove: handleAvatarPointerMove,
    onPointerUp: clearLongPressTimer,
    onPointerCancel: clearLongPressTimer,
    onPointerLeave: clearLongPressTimer,
    onContextMenu: handleAvatarContextMenu,
    onDragStart: (event: React.DragEvent<HTMLButtonElement>) =>
      event.preventDefault(),
  };
  // One identity anatomy for Chat and Discuss, including threaded replies.
  // Metadata intentionally sits outside the square avatar button so it cannot
  // be clipped by the shared control's overflow guard.
  const identityColumn = (
    <div
      data-content-size="regular"
      className={cn(
        "flex flex-shrink-0 flex-col items-center gap-0.5 pt-0.5 font-utility",
        identityRailWidthClasses.regular,
      )}
    >
      <UiButton variant="plain"
        type="button"
        {...avatarInteractionProps}
        square
        controlSize="regular"
        className="touch-manipulation select-none transition-opacity hover:opacity-80 focus-visible:ring-indigo-500/70"
        title={
          canMention
            ? `View profile · double-click to mention @${name}`
            : hasName
              ? name
              : message.sender_id
        }
        aria-label={`View profile for ${name}`}
      >
        <Avatar
          name={name}
          src={profileCard?.memberOf(message.sender_id)?.avatar_url ?? undefined}
          id={message.sender_id}
          size="regular"
        />
      </UiButton>
      <span
        className={cn(
          "block w-full truncate text-center font-medium leading-4 text-zinc-300",
          controlTextClasses.regular,
        )}
        title={name}
      >
        {name}
      </span>
    </div>
  );
  const identityPlaceholder = (
    <div
      data-content-size="regular"
      className={cn(
        "flex flex-shrink-0 items-start justify-center pt-1 font-utility",
        identityRailWidthClasses.regular,
      )}
      aria-hidden="true"
    />
  );
  const avatarMenu = avatarMenuOpen ? (
    <FloatingLayer
      anchorRef={avatarRef}
      placement="down"
      align={isOwnAlignedRight ? "end" : "start"}
      role="menu"
      className="w-56 overflow-hidden rounded-sm bg-zinc-900 p-1.5 shadow-xl shadow-black/40"
    >
      <UiButton controlWidth="fill" variant="plain"
        type="button"
        role="menuitem"
        onClick={mentionSender}
        controlSize="comfortable" className="flex items-center gap-3 rounded-sm text-left text-regular text-indigo-300 transition-colors hover:bg-zinc-800 hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70"
      >
        <AtSign className="h-4 w-4" />
        <span className="min-w-0 truncate">Mention @{name}</span>
      </UiButton>
      <UiButton controlWidth="fill" variant="plain"
        type="button"
        role="menuitem"
        onClick={() => {
          const anchor = avatarRef.current;
          setAvatarMenuOpen(false);
          if (anchor) openProfile(anchor);
        }}
        controlSize="comfortable" className="flex items-center gap-3 rounded-sm text-left text-regular text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/70"
      >
        <UserRound className="h-4 w-4" />
        View profile
      </UiButton>
    </FloatingLayer>
  ) : null;
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
  const folio = detailsMeta.hasDetails ? (
    <UiButton variant="plain"
      type="button"
      onClick={(event) => openInspector(event.currentTarget)}
      aria-label={`Open message record${detailsSummary ? `, ${detailsSummary}` : ""}`}
      title={`Message record${detailsSummary ? ` · ${detailsSummary}` : ""}`}
      square controlSize="compact" className={cn(
 "relative inline-flex items-center justify-center self-start text-zinc-500 opacity-0 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100",
 isOwnAlignedRight && "self-end",
 detailsMeta.hasFailure && "text-red-400/70 opacity-100 hover:text-red-300",
 )}
    >
      <ListTree className={controlIconClasses.compact} aria-hidden />
    </UiButton>
  ) : null;
  const detailsSection = detailsMeta.hasDetails && (detailsMeta.hasFailure || keepTraceInline) ? (
    <div className={cn("flex max-w-full flex-col", isOwnAlignedRight && "items-end")}>
      {detailsMeta.hasFailure && (
        <div role="alert" className={cn("flex min-h-8 items-center gap-1.5 text-red-400", controlTextClasses.compact)}>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Agent step failed</span>
          <UiButton variant="plain"
            type="button"
            onClick={(event) => openInspector(event.currentTarget)}
            className="font-medium text-red-300 underline underline-offset-2 hover:text-red-200"
          >
            View record
          </UiButton>
        </div>
      )}
      {tracePanel && <div className="mt-1 w-full min-w-0 text-left md:min-w-[18rem]">{tracePanel}</div>}
    </div>
  ) : null;
  const inspector = inspectorOpen && detailsMeta.hasDetails ? (
    <MessageRecordInspector
      message={message}
      channelId={channelId}
      currentUserId={currentUserId}
      pendingApprovals={pendingApprovals}
      focusRequestId={focusRequestId}
      meta={detailsMeta}
      triggerRef={inspectorTriggerRef}
      onClose={() => setInspectorOpen(false)}
    />
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
        data-item-kind="conversation"
        data-presentation-level={presentationLevel}
        className={cn(
          "group relative flex items-start gap-3 rounded-sm transition-colors hover:z-20 focus-within:z-20",
          nested
            ? "w-full px-2 py-1 hover:bg-zinc-900/40 md:w-fit md:max-w-[56rem]"
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
        {isConsecutive ? identityPlaceholder : identityColumn}
        {avatarMenu}
        {/* Tight gap: body ↔ status ↔ Agent steps within one message. */}
        <div
          ref={contentRef}
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-1.5 md:flex-none md:w-fit md:max-w-[52rem]",
            isOwnAlignedRight && "items-end",
          )}
        >
          {quote}
          <MessageBody message={message} channelId={channelId} isBot={isBot} />
          {presentationLevel !== "minimal" && folio}
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
          {(presentationLevel !== "minimal" || actionableApprovalCount > 0) && detailsSection}
        </div>
        {showActions && (
          <ActionBar
            message={message}
            actions={actions}
            anchorRef={contentRef}
            visible={actionsVisible}
            onEnter={showActionBar}
            onLeave={hideActionBar}
            hasDetails={detailsMeta.hasDetails}
            onOpenDetails={openInspector}
            canMention={canMention}
            mentionLabel={name}
          />
        )}
        {inspector}
      </div>
    );
  }

  return (
    <div
      data-item-kind="conversation"
      data-presentation-level={presentationLevel}
      className={cn(
        "group relative mx-2 flex items-start gap-3 rounded-sm px-3 py-2 transition-colors hover:z-20 hover:bg-zinc-900/45 focus-within:z-20 md:mx-4 md:px-4",
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
      {identityColumn}
      {avatarMenu}

      {/* Tight gap: header/body ↔ status ↔ Agent steps within one message. */}
      <div
        ref={contentRef}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-1.5 md:w-fit md:max-w-[52rem] md:flex-[0_1_auto]",
          isOwnAlignedRight && "items-end",
        )}
      >
        {quote}
        <MessageBody message={message} channelId={channelId} isBot={isBot} />
        {presentationLevel !== "minimal" && folio}
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
        {(presentationLevel !== "minimal" || actionableApprovalCount > 0) && detailsSection}
      </div>
      {showActions && (
        <ActionBar
          message={message}
          actions={actions}
          anchorRef={contentRef}
          visible={actionsVisible}
          onEnter={showActionBar}
          onLeave={hideActionBar}
          hasDetails={detailsMeta.hasDetails}
          onOpenDetails={openInspector}
          canMention={canMention}
          mentionLabel={name}
        />
      )}
      {inspector}
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
    <UiButton variant="plain"
      type="button"
      disabled={stopping}
      onClick={async () => {
        setStopping(true);
        // On success leave it disabled: the turn finalizes via the stream and
        // the bubble drops out of its active state, unmounting this button.
        const ok = await stopTurn(channelId, msgId);
        if (!ok) setStopping(false);
      }}
      controlSize="regular" className="inline-flex items-center gap-1 rounded-sm bg-zinc-800/80 text-compact text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-50"
      title="Stop this turn — and any bot-to-bot chain it started"
    >
      <Square className="w-3 h-3" fill="currentColor" />
      {stopping ? "Stopping…" : "Stop"}
    </UiButton>
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
          <span data-design-system-exempt="progress" className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce motion-reduce:animate-none [animation-delay:0ms]" />
          <span data-design-system-exempt="progress" className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce motion-reduce:animate-none [animation-delay:150ms]" />
          <span data-design-system-exempt="progress" className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce motion-reduce:animate-none [animation-delay:300ms]" />
        </div>
        {message._trace && (
          <span className="text-compact text-zinc-400 italic truncate">
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
    return <p className="text-regular text-red-400 italic">{message.error}</p>;
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
            <MarkdownRenderer
              content={content}
              className="font-reading text-regular font-normal leading-[1.55] tracking-[-0.005em]"
            />
          </PathOpenContext.Provider>
        ) : (
          <p className="font-reading text-regular font-normal leading-[1.55] tracking-[-0.005em] text-zinc-200 whitespace-pre-wrap break-words">
            {content}
          </p>
        ))}
      {message._streaming && (
        <span className="inline-block w-0.5 h-4 bg-zinc-400 animate-blink motion-reduce:animate-none ml-0.5 align-text-bottom" />
      )}
      {active && message._trace && (
        <p className="text-compact text-zinc-400 italic mt-0.5">{message._trace}</p>
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
