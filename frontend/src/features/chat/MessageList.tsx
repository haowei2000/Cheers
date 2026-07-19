import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Spinner } from "@/components/ui/spinner";
import toast from "react-hot-toast";
import { MessageItem, type MessageActionHandlers } from "./MessageItem";
import { formatDayLabel, sameDay } from "@/lib/format";
import type { Message, PermissionContentData } from "@/types";

// Skip layout/paint for off-screen rows during frequent streaming re-renders while
// keeping every row in the DOM — the data-msg-id jump, native scroll anchoring on
// prepend, day labels, and auto-scroll all keep working. `auto` in contain-intrinsic-size
// remembers each row's last real height; 80px is only the estimate for never-rendered rows.
const ROW_CONTENT_VISIBILITY: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 80px",
};

// A RESOLVED approval no longer needs its own line in the channel — the decision is
// persisted in the bot turn's trace and reachable via the per-message "Agent steps"
// reveal (BotTracePanel). Pending approvals stay inline: they're actionable. Filtering
// these out up front keeps day-label / consecutive grouping correct.
function isResolvedPermission(m: Message): boolean {
  return (
    m.msg_type === "permission" &&
    (m.content_data as PermissionContentData | null | undefined)?.resolved === true
  );
}

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
  focusMsg?: { msgId: string; nonce: number } | null;
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
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // Transient flash for a jumped-to message (cleared after the highlight fades).
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // External jump (ViewBoard history rows): scroll to the anchored row + flash.
  // ChannelView backfills older pages before focusing, so by the time focusMsg
  // lands the message is loaded — no anchor now means the row exists but isn't
  // rendered (e.g. a resolved approval folded into the bot turn's trace).
  useEffect(() => {
    if (!focusMsg) return;
    const el = containerRef.current?.querySelector(
      `[data-msg-id="${CSS.escape(focusMsg.msgId)}"]`
    );
    if (!el) {
      toast("This message isn't shown in the channel view", { icon: "🔍", id: "jump-hidden" });
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightId(focusMsg.msgId);
    // content-visibility rows above the target materialize their real heights
    // during the smooth scroll (backfilled pages arrive with 80px estimates),
    // drifting the anchor — one instant corrective pass after it settles.
    const settle = setTimeout(() => {
      containerRef.current
        ?.querySelector(`[data-msg-id="${CSS.escape(focusMsg.msgId)}"]`)
        ?.scrollIntoView({ block: "center" });
    }, 700);
    const t = setTimeout(() => setHighlightId(null), 1800);
    return () => {
      clearTimeout(settle);
      clearTimeout(t);
    };
  }, [focusMsg]);

  // Resolved approvals are folded into each bot turn's trace, not shown as their own rows.
  const visible = useMemo(
    () => messages.filter((m) => !isResolvedPermission(m)),
    [messages]
  );

  // msg_id → message, to resolve each reply's quoted original from the loaded window.
  const byId = useMemo(() => {
    const m = new Map<string, Message>();
    for (const msg of messages) m.set(msg.msg_id, msg);
    return m;
  }, [messages]);
  const nameOf = useMemo(
    () => (senderId: string) => senderNames?.get(senderId) ?? senderId.slice(0, 8),
    [senderNames]
  );
  const prevLenRef = useRef(visible.length);

  // Channel switch: the next content commit is a whole new timeline (cache seed
  // or cold reload), not an append — jump straight to the bottom instantly.
  // Flagged at render time and consumed by the auto-scroll effect below, which
  // only fires once `visible` actually changes identity (the seeded commit).
  const lastChannelRef = useRef(channelId);
  const channelSwitchScrollRef = useRef(false);
  if (lastChannelRef.current !== channelId) {
    lastChannelRef.current = channelId;
    channelSwitchScrollRef.current = true;
    isAtBottomRef.current = true;
  }

  // Track scroll position
  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;

    // Load more when near top
    if (el.scrollTop < 120 && hasMore && onLoadMore && !loading) {
      onLoadMore();
    }
  }

  // Auto-scroll on new messages
  useEffect(() => {
    const newLen = visible.length;
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
  }, [visible]);

  // Initial scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, []);

  if (!loading && visible.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        No messages yet. Start the conversation!
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto overscroll-contain py-2"
    >
      {loading && (
        <div className="flex justify-center py-4">
          <Spinner size={20} className="text-zinc-600" />
        </div>
      )}

      {visible.map((msg, i) => {
        const prev = visible[i - 1];
        const showDayLabel = !prev || !sameDay(prev.created_at, msg.created_at);
        const isConsecutive =
          !showDayLabel &&
          prev &&
          prev.sender_id === msg.sender_id &&
          prev.sender_type === msg.sender_type &&
          !prev.is_deleted;

        return (
          <div key={msg.msg_id}>
            {showDayLabel && (
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 h-px bg-zinc-800" />
                <span className="text-xs text-zinc-400 font-medium">
                  {formatDayLabel(msg.created_at)}
                </span>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>
            )}
            <div
              data-msg-id={msg.msg_id}
              style={ROW_CONTENT_VISIBILITY}
              className={
                msg.msg_id === highlightId
                  ? "rounded-lg bg-indigo-500/10 ring-1 ring-inset ring-indigo-500/40 transition-colors duration-700"
                  : "transition-colors duration-700"
              }
            >
              <MessageItem
                message={msg}
                isConsecutive={!!isConsecutive}
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
              />
            </div>
          </div>
        );
      })}

      <div ref={bottomRef} className="h-4" />
    </div>
  );
}
