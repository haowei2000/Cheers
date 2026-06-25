import { useEffect, useRef } from "react";
import { MessageItem } from "./MessageItem";
import { formatDayLabel, sameDay } from "@/lib/format";
import type { Message } from "@/types";

interface Props {
  messages: Message[];
  currentUserId?: string;
  channelId?: string;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loading?: boolean;
}

export function MessageList({
  messages,
  currentUserId,
  channelId,
  hasMore,
  onLoadMore,
  loading,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevLenRef = useRef(messages.length);

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
    const newLen = messages.length;
    const grew = newLen > prevLenRef.current;
    prevLenRef.current = newLen;

    if (grew && isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Initial scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, []);

  if (!loading && messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
        No messages yet. Start the conversation!
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto py-2"
    >
      {loading && (
        <div className="flex justify-center py-4">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-indigo-500 rounded-full animate-spin" />
        </div>
      )}

      {messages.map((msg, i) => {
        const prev = messages[i - 1];
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
                <span className="text-xs text-zinc-500 font-medium">
                  {formatDayLabel(msg.created_at)}
                </span>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>
            )}
            <MessageItem
              message={msg}
              isConsecutive={!!isConsecutive}
              currentUserId={currentUserId}
              channelId={channelId}
            />
          </div>
        );
      })}

      <div ref={bottomRef} className="h-4" />
    </div>
  );
}
