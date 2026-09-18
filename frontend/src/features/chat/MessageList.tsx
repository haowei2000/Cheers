import { useReadingPosition } from "@/hooks/useReadingPosition";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Button as UiButton } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
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
import { inDiscussionThread } from "./discussionThread";

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

/** Collect all nested descendants of a discussion message in chronological sequence. */
export function collectThreadDescendants(
  parentId: string,
  childrenByParent: Map<string, Message[]>,
): Message[] {
  const direct = childrenByParent.get(parentId) ?? [];
  const all: Message[] = [];
  for (const child of direct) {
    all.push(child);
    all.push(...collectThreadDescendants(child.msg_id, childrenByParent));
  }
  return all.sort((a, b) => (a.channel_seq ?? 0) - (b.channel_seq ?? 0));
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
  focusMsg?: { msgId: string; nonce: number; requestId?: string | null } | null;
  /** When set, scroll the reply target into view (composer stays at the bottom). */
  replyToId?: string | null;
  /** `chat` is a flat chronological timeline; `discuss` nests replies by topic. */
  conversationMode?: ConversationMode;
  /** Render only descendants of this message (the topic root stays in the header). */
  threadRootId?: string | null;
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
  threadRootId = null,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  useReadingPosition(containerRef, `${channelId}:${loading && !messages.length ? "loading" : "ready"}:${threadRootId}`);
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

  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());

  const toggleSubthread = useCallback((threadId: string) => {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  const level1Replies = useMemo(() => {
    if (!threadRootId) return [];
    const direct = childrenByParent.get(threadRootId) ?? [];
    const orphans = roots.filter(
      (m) =>
        m.msg_id !== threadRootId &&
        (m.thread_root_msg_id === threadRootId || (!m.reply_to_msg_id && inDiscussionThread(m, threadRootId))),
    );
    const merged = [...direct];
    for (const orphan of orphans) {
      if (!merged.some((m) => m.msg_id === orphan.msg_id)) {
        merged.push(orphan);
      }
    }
    return merged.sort((a, b) => (a.channel_seq ?? 0) - (b.channel_seq ?? 0));
  }, [childrenByParent, roots, threadRootId]);

  // Auto-expand sub-thread if an active jump or reply target is inside it
  useEffect(() => {
    const targetId = focusMsg?.msgId || highlightId || replyToId;
    if (!targetId) return;

    const candidateParents = threadRootId
      ? level1Replies
      : roots.flatMap((r) => childrenByParent.get(r.msg_id) ?? []);

    for (const parent of candidateParents) {
      const subs = collectThreadDescendants(parent.msg_id, childrenByParent);
      if (subs.some((s) => s.msg_id === targetId)) {
        setExpandedThreads((prev) => {
          if (prev.has(parent.msg_id)) return prev;
          const next = new Set(prev);
          next.add(parent.msg_id);
          return next;
        });
        break;
      }
    }
  }, [focusMsg, highlightId, replyToId, threadRootId, level1Replies, childrenByParent, roots]);

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
    // The workspace may reveal a hidden narrow-screen timeline in this commit.
    const frame = requestAnimationFrame(() => el.scrollIntoView({ block: "center", behavior: "smooth" }));
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
      cancelAnimationFrame(frame);
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
    if (!el || !el.clientHeight) return;
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
      <div className="flex-1 flex items-center justify-center font-reading italic text-content-muted text-regular">
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
        <span className="h-px flex-1 bg-zinc-300/40 dark:bg-zinc-800/60" />
        <span className="px-2 font-serif text-compact italic tracking-wide text-content-muted select-none">
          {formatDayLabel(msg.created_at)}
        </span>
        <span className="h-px flex-1 bg-zinc-300/40 dark:bg-zinc-800/60" />
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

  function renderSubthread(parentMsg: Message, subReplies: Message[]) {
    const isExpanded = expandedThreads.has(parentMsg.msg_id);
    const needsCollapse = subReplies.length > 3;
    const visibleReplies = needsCollapse && !isExpanded ? subReplies.slice(0, 2) : subReplies;

    return (
      <div className="ml-10 mt-2 flex flex-col gap-2 rounded-sm border-l-2 border-zinc-800/80 bg-zinc-900/40 p-2 md:ml-12">
        {visibleReplies.map((sub, j) => {
          const targetMsg = sub.reply_to_msg_id ? byId.get(sub.reply_to_msg_id) ?? null : null;
          const isReplyToReply = targetMsg && targetMsg.msg_id !== parentMsg.msg_id;
          const subConsecutive = j > 0 && isDiscussionConsecutive(visibleReplies[j - 1]!, sub);

          return (
            <div
              key={sub.msg_id}
              data-msg-id={sub.msg_id}
              style={ROW_CONTENT_VISIBILITY}
              className={rowHighlightClass(sub)}
            >
              <MessageItem
                message={sub}
                isConsecutive={subConsecutive}
                nested={true}
                alignOwnMessages={false}
                identityLayout="avatar"
                hideReplyQuote={!isReplyToReply}
                currentUserId={currentUserId}
                channelId={channelId}
                senderName={senderNames?.get(sub.sender_id)}
                actions={actions}
                selectMode={selectMode}
                selected={selectedIds?.has(sub.msg_id) ?? false}
                repliedTo={isReplyToReply ? targetMsg : null}
                nameOf={nameOf}
                pendingApprovals={approvalsBySource.get(sub.msg_id)}
                focusRequestId={focusRequestIdFor(sub)}
              />
            </div>
          );
        })}

        {needsCollapse && (
          <div className="flex items-center gap-2 py-1 text-content-muted" role="separator">
            <span className="h-px flex-1 bg-zinc-300/40 dark:bg-zinc-800/60" />
            <UiButton
              action={isExpanded ? "collapse" : "expand"}
              content="icon"
              variant="plain"
              controlSize="compact"
              type="button"
              onClick={() => toggleSubthread(parentMsg.msg_id)}
              aria-label={isExpanded ? "Collapse replies" : "Expand replies"}
              aria-expanded={isExpanded}
              title={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </UiButton>
            <span className="h-px flex-1 bg-zinc-300/40 dark:bg-zinc-800/60" />
          </div>
        )}
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
            <Spinner contentSize="large" className="text-content-muted" />
          </div>
        )}

        {/* Chat stays chronological. Discuss groups replies directly below roots. */}
        <div className="flex flex-col gap-4">
          {threadRootId ? (
            level1Replies.map((level1, i, siblings) => {
              const isConsecutive = i > 0 && isDiscussionConsecutive(siblings[i - 1]!, level1);
              const subReplies = collectThreadDescendants(level1.msg_id, childrenByParent);
              return (
                <div key={level1.msg_id} className={isConsecutive ? "-mt-3" : undefined}>
                  <div
                    data-msg-id={level1.msg_id}
                    style={ROW_CONTENT_VISIBILITY}
                    className={rowHighlightClass(level1)}
                  >
                    <MessageItem
                      message={level1}
                      isConsecutive={isConsecutive}
                      nested={false}
                      alignOwnMessages={false}
                      identityLayout="avatar"
                      hideReplyQuote={true}
                      currentUserId={currentUserId}
                      channelId={channelId}
                      senderName={senderNames?.get(level1.sender_id)}
                      actions={actions}
                      selectMode={selectMode}
                      selected={selectedIds?.has(level1.msg_id) ?? false}
                      repliedTo={
                        level1.reply_to_msg_id
                          ? byId.get(level1.reply_to_msg_id) ?? null
                          : null
                      }
                      nameOf={nameOf}
                      pendingApprovals={approvalsBySource.get(level1.msg_id)}
                      focusRequestId={focusRequestIdFor(level1)}
                    />
                  </div>
                  {subReplies.length > 0 && renderSubthread(level1, subReplies)}
                </div>
              );
            })
          ) : conversationMode === "discuss" ? (
            roots.map((rootMsg, i) => {
              const showDayLabel = !i || !sameDay(roots[i - 1]!.created_at, rootMsg.created_at);
              const isConsecutive = !showDayLabel && i > 0 && isVisuallyConsecutive(roots[i - 1]!, rootMsg);
              const level1Kids = childrenByParent.get(rootMsg.msg_id) ?? [];
              return (
                <div key={rootMsg.msg_id} className={isConsecutive ? "-mt-3" : undefined}>
                  {showDayLabel && renderDayLabel(rootMsg)}
                  <div
                    data-msg-id={rootMsg.msg_id}
                    style={ROW_CONTENT_VISIBILITY}
                    className={rowHighlightClass(rootMsg)}
                  >
                    <MessageItem
                      message={rootMsg}
                      isConsecutive={isConsecutive}
                      nested={false}
                      alignOwnMessages={false}
                      identityLayout="avatar"
                      hideReplyQuote={true}
                      currentUserId={currentUserId}
                      channelId={channelId}
                      senderName={senderNames?.get(rootMsg.sender_id)}
                      actions={actions}
                      selectMode={selectMode}
                      selected={selectedIds?.has(rootMsg.msg_id) ?? false}
                      repliedTo={null}
                      nameOf={nameOf}
                      pendingApprovals={approvalsBySource.get(rootMsg.msg_id)}
                      focusRequestId={focusRequestIdFor(rootMsg)}
                    />
                  </div>
                  {level1Kids.length > 0 && (
                    <div className="ml-10 mr-3 mt-3 flex flex-col gap-3 md:ml-14 md:mr-5">
                      {level1Kids.map((level1, j, siblings) => {
                        const level1Consecutive = j > 0 && isDiscussionConsecutive(siblings[j - 1]!, level1);
                        const subReplies = collectThreadDescendants(level1.msg_id, childrenByParent);
                        return (
                          <div key={level1.msg_id} className={level1Consecutive ? "-mt-3" : undefined}>
                            <div
                              data-msg-id={level1.msg_id}
                              style={ROW_CONTENT_VISIBILITY}
                              className={rowHighlightClass(level1)}
                            >
                              <MessageItem
                                message={level1}
                                isConsecutive={level1Consecutive}
                                nested={true}
                                alignOwnMessages={false}
                                identityLayout="avatar"
                                hideReplyQuote={true}
                                currentUserId={currentUserId}
                                channelId={channelId}
                                senderName={senderNames?.get(level1.sender_id)}
                                actions={actions}
                                selectMode={selectMode}
                                selected={selectedIds?.has(level1.msg_id) ?? false}
                                repliedTo={rootMsg}
                                nameOf={nameOf}
                                pendingApprovals={approvalsBySource.get(level1.msg_id)}
                                focusRequestId={focusRequestIdFor(level1)}
                              />
                            </div>
                            {subReplies.length > 0 && renderSubthread(level1, subReplies)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            topLevel.map((msg, i) =>
              renderChatMessage(msg, i > 0 ? topLevel[i - 1]! : null),
            )
          )}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
