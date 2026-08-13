import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Spinner } from "@/components/ui/spinner";
import toast from "react-hot-toast";
import { MessageItem, type MessageActionHandlers } from "./MessageItem";
import { formatDayLabel, sameDay } from "@/lib/format";
import type { Message } from "@/types";
import {
  isDiscussionConsecutive,
  isVisuallyConsecutive,
  isFoldedPermission,
  permissionSourceId,
} from "./messageTree";
import { layoutMessages, type ConversationMode } from "./conversationMode";

// Chat timeline spacing (3 levels):
//   tight  — within one message (body ↔ files ↔ Agent steps): gap-1
//   medium — parent ↔ reply / sibling replies: gap-2 + mt-2
//   wide   — root ↔ root: gap-4

// Skip layout/paint for off-screen rows during frequent streaming re-renders while
// keeping every row in the DOM — the data-msg-id jump, native scroll anchoring on
// prepend, day labels, and auto-scroll all keep working. `auto` in contain-intrinsic-size
// remembers each row's last real height; 80px is only the estimate for never-rendered rows.
const ROW_CONTENT_VISIBILITY: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 80px",
};

interface Props {
  messages: Message[];
  currentUserId?: string;
  channelId?: string;
  /** Member id → display label, for messages that arrive without a sender_name. */
  senderNames?: Map<string, string>;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loading?: boolean;
  /** Reply / copy / forward / multi-select callbacks (stable identity). */
  actions?: MessageActionHandlers;
  selectMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  /** Jump request from outside (ViewBoard history items): scroll the message into
   *  view and flash it. `nonce` distinguishes repeat jumps to the same message.
   *  The sender (ChannelView) backfills history first, so the target is loaded. */
  focusMsg?: { msgId: string; nonce: number; requestId?: string | null } | null;
  /** When set, scroll the reply target into view (composer stays at the bottom). */
  replyToId?: string | null;
  /** `chat` is a flat chronological timeline; `discuss` nests replies by topic. */
  conversationMode?: ConversationMode;
}

export function MessageList({
  messages,
  currentUserId,
  channelId,
  senderNames,
  hasMore,
  onLoadMore,
  loading,
  actions,
  selectMode,
  selectedIds,
  focusMsg,
  replyToId,
  conversationMode = "chat",
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // Transient flash for a jumped-to message (cleared after the highlight fades).
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Approvals keyed by the bot-turn msg_id they belong to (pending + resolved).
  const approvalsBySource = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const m of messages) {
      if (m.msg_type !== "permission") continue;
      const source = permissionSourceId(m);
      if (!source) continue;
      const list = map.get(source);
      if (list) list.push(m);
      else map.set(source, [m]);
    }
    return map;
  }, [messages]);

  const { roots, childrenByParent, byId, topLevel } = useMemo(
    () => layoutMessages(messages, conversationMode),
    [conversationMode, messages],
  );

  // External jump (ViewBoard history rows): scroll to the anchored row + flash.
  // ChannelView backfills older pages before focusing, so by the time focusMsg
  // lands the message is loaded — no anchor now means the row exists but isn't
  // rendered (e.g. an approval folded into the bot turn's Agent steps). Prefer
  // the source bot turn when the target is a folded permission card.
  useEffect(() => {
    if (!focusMsg) return;
    const folded = messages.find((m) => m.msg_id === focusMsg.msgId);
    const targetId =
      folded && isFoldedPermission(folded)
        ? permissionSourceId(folded) ?? focusMsg.msgId
        : focusMsg.msgId;
    const el = containerRef.current?.querySelector(
      `[data-msg-id="${CSS.escape(targetId)}"]`,
    );
    if (!el) {
      toast("This message isn't shown in the channel view", {
        icon: "🔍",
        id: "jump-hidden",
      });
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightId(targetId);
    // content-visibility rows above the target materialize their real heights
    // during the smooth scroll (backfilled pages arrive with 80px estimates),
    // drifting the anchor — one instant corrective pass after it settles.
    const settle = setTimeout(() => {
      containerRef.current
        ?.querySelector(`[data-msg-id="${CSS.escape(targetId)}"]`)
        ?.scrollIntoView({ block: "center" });
    }, 700);
    const t = setTimeout(() => setHighlightId(null), 1800);
    return () => {
      clearTimeout(settle);
      clearTimeout(t);
    };
  }, [focusMsg, messages]);

  const nameOf = useMemo(
    () => (senderId: string) =>
      senderNames?.get(senderId) ?? senderId.slice(0, 8),
    [senderNames],
  );

  // Both modes render the same set of messages; only their presentation differs.
  const renderedCount = messages.reduce(
    (count, message) => count + (isFoldedPermission(message) ? 0 : 1),
    0,
  );
  const prevLenRef = useRef(renderedCount);

  // Channel switch: the next content commit is a whole new timeline (cache seed
  // or cold reload), not an append — jump straight to the bottom instantly.
  const lastChannelRef = useRef(channelId);
  const channelSwitchScrollRef = useRef(false);
  if (lastChannelRef.current !== channelId) {
    lastChannelRef.current = channelId;
    channelSwitchScrollRef.current = true;
    isAtBottomRef.current = true;
  }

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;

    if (el.scrollTop < 120 && hasMore && onLoadMore && !loading) {
      onLoadMore();
    }
  }

  useEffect(() => {
    const newLen = renderedCount;
    const grew = newLen > prevLenRef.current;
    prevLenRef.current = newLen;

    if (channelSwitchScrollRef.current) {
      channelSwitchScrollRef.current = false;
      bottomRef.current?.scrollIntoView();
      return;
    }
    if (grew && isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [renderedCount]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, []);

  // Scroll inline reply into view when reply target changes.
  useEffect(() => {
    if (!replyToId) return;
    const el = containerRef.current?.querySelector(
      `[data-msg-id="${CSS.escape(replyToId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [replyToId]);

  if (!loading && topLevel.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-regular">
        No messages yet. Start the conversation!
      </div>
    );
  }

  function focusRequestIdFor(msg: Message) {
    return focusMsg &&
      (focusMsg.msgId === msg.msg_id ||
        (approvalsBySource.get(msg.msg_id) ?? []).some(
          (approval) => approval.msg_id === focusMsg.msgId,
        ))
      ? focusMsg.requestId ?? null
      : null;
  }

  function renderDayLabel(msg: Message) {
    return (
      <div className="flex items-center gap-3 px-4 pb-2 pt-8" role="separator">
        <span className="h-px flex-1 bg-zinc-800/80" />
        <span className="rounded-sm bg-zinc-950 px-3 py-1 text-compact font-medium text-zinc-400">
          {formatDayLabel(msg.created_at)}
        </span>
        <span className="h-px flex-1 bg-zinc-800/80" />
      </div>
    );
  }

  function rowHighlightClass(msg: Message) {
    return msg.msg_id === highlightId
      ? "rounded-sm bg-indigo-500/10 ring-1 ring-inset ring-indigo-500/40 transition-colors duration-700"
      : "transition-colors duration-700";
  }

  function renderChatMessage(msg: Message, previous: Message | null) {
    const showDayLabel = !previous || !sameDay(previous.created_at, msg.created_at);
    const isConsecutive =
      !showDayLabel && !!previous && isVisuallyConsecutive(previous, msg);
    return (
      <div key={msg.msg_id} className={isConsecutive ? "-mt-3" : undefined}>
        {showDayLabel && renderDayLabel(msg)}
        <div
          data-msg-id={msg.msg_id}
          style={ROW_CONTENT_VISIBILITY}
          className={rowHighlightClass(msg)}
        >
          <MessageItem
            message={msg}
            isConsecutive={isConsecutive}
            alignOwnMessages
            currentUserId={currentUserId}
            channelId={channelId}
            senderName={senderNames?.get(msg.sender_id)}
            actions={actions}
            selectMode={selectMode}
            selected={selectedIds?.has(msg.msg_id) ?? false}
            repliedTo={
              msg.reply_to_msg_id ? byId.get(msg.reply_to_msg_id) ?? null : null
            }
            nameOf={nameOf}
            pendingApprovals={approvalsBySource.get(msg.msg_id)}
            focusRequestId={focusRequestIdFor(msg)}
          />
        </div>
      </div>
    );
  }

  function renderNode(msg: Message, depth: number, prevRoot: Message | null) {
    const kids = childrenByParent.get(msg.msg_id) ?? [];
    const showDayLabel =
      depth === 0 &&
      (!prevRoot || !sameDay(prevRoot.created_at, msg.created_at));
    const isConsecutive = depth === 0
      ? !showDayLabel && !!prevRoot && isVisuallyConsecutive(prevRoot, msg)
      : !!prevRoot && isDiscussionConsecutive(prevRoot, msg);
    const parentInView = !!(
      msg.reply_to_msg_id && byId.has(msg.reply_to_msg_id)
    );

    return (
      <div key={msg.msg_id} className={isConsecutive ? "-mt-3" : undefined}>
        {showDayLabel && renderDayLabel(msg)}
        <div
          data-msg-id={msg.msg_id}
          style={ROW_CONTENT_VISIBILITY}
          className={rowHighlightClass(msg)}
        >
          <MessageItem
            message={msg}
            isConsecutive={!!isConsecutive}
            nested={depth > 0}
            alignOwnMessages={false}
            hideReplyQuote={parentInView}
            currentUserId={currentUserId}
            channelId={channelId}
            senderName={senderNames?.get(msg.sender_id)}
            actions={actions}
            selectMode={selectMode}
            selected={selectedIds?.has(msg.msg_id) ?? false}
            repliedTo={
              msg.reply_to_msg_id
                ? byId.get(msg.reply_to_msg_id) ?? null
                : null
            }
            nameOf={nameOf}
            pendingApprovals={approvalsBySource.get(msg.msg_id)}
            focusRequestId={focusRequestIdFor(msg)}
          />
          {kids.length > 0 && (
            // Medium gap: parent ↔ replies, and sibling replies.
            <div
              className={
                depth === 0
                  ? "relative ml-10 mr-3 mt-3 flex flex-col gap-2 md:ml-14 md:mr-5"
                  : "relative ml-3 mt-2 flex flex-col gap-2"
              }
            >
              {kids.map((child, i) => {
                const isLast = i === kids.length - 1;
                return (
                  <div key={child.msg_id} className="relative pl-4">
                    {/* Thread rail: full height between siblings; stops at the elbow on the last. */}
                    <span
                      aria-hidden
                      className={
                        isLast
                          ? "pointer-events-none absolute left-0 top-0 h-4 w-px bg-zinc-700/70"
                          : "pointer-events-none absolute bottom-0 left-0 top-0 w-px bg-zinc-700/70"
                      }
                    />
                    {/* Horizontal stub → L-corner into the nested row (no ↳ glyph). */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute left-0 top-4 w-3 border-t border-zinc-700/70"
                    />
                    {renderNode(
                      child,
                      depth + 1,
                      i > 0 && isDiscussionConsecutive(kids[i - 1], child)
                        ? kids[i - 1]
                        : null,
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="chat-scrollbar flex-1 overflow-y-auto overscroll-contain py-2"
    >
      <div className="mx-auto w-full max-w-[72rem]">
        {loading && (
          <div className="flex justify-center py-4">
            <Spinner contentSize="large" className="text-zinc-400" />
          </div>
        )}

        {/* Chat stays chronological. Discuss groups replies directly below roots. */}
        <div className="flex flex-col gap-4">
          {conversationMode === "discuss"
            ? roots.map((msg, i) =>
                renderNode(msg, 0, i > 0 ? roots[i - 1]! : null),
              )
            : topLevel.map((msg, i) =>
                renderChatMessage(msg, i > 0 ? topLevel[i - 1]! : null),
              )}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
