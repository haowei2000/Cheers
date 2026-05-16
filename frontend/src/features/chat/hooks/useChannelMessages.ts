import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction, UIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AuthFetch } from "../../../api/client";
import { API } from "../../../lib/app-config";
import { isClarifyReplyUserMessage } from "../../../lib/helper";
import { buildTopicTree, isMsgReply, mergeMessagesChronologically } from "../../../lib/message";
import {
  INITIAL_MESSAGE_PAGE_SIZE,
  MAX_LOADED_MESSAGES,
  OLDER_MESSAGE_PAGE_SIZE,
  trimToRecentMessages,
  VIRTUAL_MESSAGE_ESTIMATED_HEIGHT,
  VIRTUAL_MESSAGE_OVERSCAN_ROWS,
} from "../../../lib/message-window";
import {
  emptyMessageStore,
  messagesToStore,
  storeToMessages,
  trimMessageStoreToRecent,
  type MessageStore,
} from "../../../lib/message-store";
import type { Message } from "../../../types";

const CHANNEL_CACHE_REVALIDATE_MS = 5_000;

interface UseChannelMessagesOptions {
  selectedId: string | null;
  isDmSelected: boolean;
  authFetch: AuthFetch;
  selectedIdRef: MutableRefObject<string | null>;
  pendingScrollMsgIdRef: MutableRefObject<string | null>;
  pageTopicMessages: Message[];
  setExpandedTopics: Dispatch<SetStateAction<Set<string>>>;
}

type ChannelMessageCacheEntry = {
  store: MessageStore;
  hasMore: boolean;
  receivedAt: number;
};

export function useChannelMessages({
  selectedId,
  isDmSelected,
  authFetch,
  selectedIdRef,
  pendingScrollMsgIdRef,
  pageTopicMessages,
  setExpandedTopics,
}: UseChannelMessagesOptions) {
  const [messageStore, setMessageStore] = useState<MessageStore>(() =>
    emptyMessageStore(),
  );
  const messages = useMemo(() => storeToMessages(messageStore), [messageStore]);
  const setMessages = useCallback(
    (next: Message[] | ((prev: Message[]) => Message[])) => {
      setMessageStore((prevStore) => {
        if (typeof next !== "function") return messagesToStore(next);
        const prevMessages = storeToMessages(prevStore);
        return messagesToStore(next(prevMessages));
      });
    },
    [],
  );
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const isLoadingOlderRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const lastAutoScrollChannelRef = useRef<string | null>(null);
  const channelMessageCacheRef = useRef<Partial<Record<string, ChannelMessageCacheEntry>>>({});
  const preloadRequestsRef = useRef<Partial<Record<string, Promise<ChannelMessageCacheEntry | null>>>>({});
  const cacheGenerationRef = useRef(0);

  const fetchInitialMessages = useCallback(
    async (
      channelId: string,
      signal?: AbortSignal,
    ): Promise<ChannelMessageCacheEntry> => {
      const response = await authFetch(
        `${API}/channels/${channelId}/messages?limit=${INITIAL_MESSAGE_PAGE_SIZE}`,
        signal ? { signal } : undefined,
      );
      const data = await response.json();
      const items = data.data || [];
      const visibleData = trimToRecentMessages(items);
      return {
        store: messagesToStore(visibleData),
        hasMore:
          Boolean(data.meta?.has_more ?? items.length >= INITIAL_MESSAGE_PAGE_SIZE) &&
          visibleData.length < MAX_LOADED_MESSAGES,
        receivedAt: Date.now(),
      };
    },
    [authFetch],
  );

  const preloadChannelMessages = useCallback(
    (channelId: string) => {
      if (
        !channelId ||
        channelMessageCacheRef.current[channelId] ||
        preloadRequestsRef.current[channelId]
      ) {
        return;
      }
      const generation = cacheGenerationRef.current;
      const request = fetchInitialMessages(channelId)
        .then((entry) => {
          if (cacheGenerationRef.current === generation) {
            channelMessageCacheRef.current[channelId] = entry;
          }
          return entry;
        })
        .catch((error) => {
          if ((error as { name?: string }).name !== "AbortError") {
            console.debug("channel message preload failed", error);
          }
          return null;
        })
        .finally(() => {
          delete preloadRequestsRef.current[channelId];
        });
      preloadRequestsRef.current[channelId] = request;
    },
    [fetchInitialMessages],
  );

  useEffect(() => {
    cacheGenerationRef.current += 1;
    channelMessageCacheRef.current = {};
    preloadRequestsRef.current = {};
  }, [authFetch]);

  useEffect(() => {
    if (!selectedId) {
      setMessageStore(emptyMessageStore());
      setHasMore(true);
      setLoading(false);
      return;
    }
    const targetChannelId = selectedId;
    const controller = new AbortController();
    const cached = channelMessageCacheRef.current[targetChannelId];
    stickToBottomRef.current = true;
    lastAutoScrollChannelRef.current = null;
    if (cached) {
      setMessageStore(cached.store);
      setHasMore(cached.hasMore);
      setLoading(false);
    } else {
      setMessageStore(emptyMessageStore());
      setHasMore(true);
      setLoading(true);
    }

    if (cached && Date.now() - cached.receivedAt < CHANNEL_CACHE_REVALIDATE_MS) {
      return () => controller.abort();
    }

    const request =
      preloadRequestsRef.current[targetChannelId] ??
      fetchInitialMessages(targetChannelId, controller.signal);

    request
      .then((entry) => {
        if (!entry) return;
        if (
          controller.signal.aborted ||
          selectedIdRef.current !== targetChannelId
        ) {
          return;
        }
        channelMessageCacheRef.current[targetChannelId] = entry;
        setMessageStore((prev) => {
          const prevMessages = storeToMessages(prev);
          if (prevMessages.length === 0) return entry.store;
          return messagesToStore(
            trimToRecentMessages(
              mergeMessagesChronologically(prevMessages, storeToMessages(entry.store)),
            ),
          );
        });
        setHasMore(entry.hasMore);
      })
      .catch((error) => {
        if ((error as { name?: string }).name === "AbortError") return;
        if (selectedIdRef.current !== targetChannelId) return;
        console.error(error);
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          selectedIdRef.current === targetChannelId
        ) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [fetchInitialMessages, selectedId, selectedIdRef]);

  useEffect(() => {
    if (!selectedId || loading) return;
    channelMessageCacheRef.current[selectedId] = {
      store: messageStore,
      hasMore,
      receivedAt: Date.now(),
    };
  }, [hasMore, loading, messageStore, selectedId]);

  const loadMoreMessages = useCallback(async () => {
    if (!selectedId || !hasMore || loadingMore) return;
    if (messages.length >= MAX_LOADED_MESSAGES) {
      setHasMore(false);
      return;
    }
    const targetChannelId = selectedId;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingMore(true);
    isLoadingOlderRef.current = true;
    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    try {
      const response = await authFetch(
        `${API}/channels/${targetChannelId}/messages?before_id=${oldest.msg_id}&limit=${OLDER_MESSAGE_PAGE_SIZE}`,
      );
      const data = await response.json();
      const older = data.data || [];
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      if (selectedIdRef.current !== targetChannelId) return;
      const hitWindowCap =
        messages.length + older.length >= MAX_LOADED_MESSAGES;
      setHasMore(
        !hitWindowCap && Boolean(data.meta?.has_more ?? older.length >= OLDER_MESSAGE_PAGE_SIZE),
      );
      setMessageStore((prev) =>
        trimMessageStoreToRecent(
          messagesToStore([...older, ...storeToMessages(prev)]),
          MAX_LOADED_MESSAGES,
        ),
      );
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - prevScrollHeight;
          stickToBottomRef.current =
            container.scrollHeight - container.scrollTop - container.clientHeight <
            160;
        }
        isLoadingOlderRef.current = false;
      });
    } catch (error) {
      console.error(error);
      isLoadingOlderRef.current = false;
    } finally {
      setLoadingMore(false);
    }
  }, [authFetch, hasMore, loadingMore, messages, selectedId, selectedIdRef]);

  const handleMessagesScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      stickToBottomRef.current =
        target.scrollHeight - target.scrollTop - target.clientHeight < 160;
      if (target.scrollTop < 100 && hasMore && !loadingMore) {
        loadMoreMessages();
      }
    },
    [hasMore, loadingMore, loadMoreMessages],
  );

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const updateMetrics = () => {
      const wasStuckToBottom = stickToBottomRef.current;
      stickToBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < 160;
      if (wasStuckToBottom && !isLoadingOlderRef.current) {
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
          stickToBottomRef.current = true;
        });
      }
    };

    updateMetrics();
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [selectedId]);

  useEffect(() => {
    const msgId = pendingScrollMsgIdRef.current;
    if (!msgId || loading || messages.length === 0) return;
    pendingScrollMsgIdRef.current = null;
    setTimeout(() => {
      const el = document.getElementById(`msg-${msgId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const idx = messages.findIndex((message) => message.msg_id === msgId);
      const container = messagesContainerRef.current;
      if (idx >= 0 && container) {
        container.scrollTop = Math.max(
          0,
          idx * VIRTUAL_MESSAGE_ESTIMATED_HEIGHT - container.clientHeight / 2,
        );
      }
    }, 100);
  }, [loading, messages, pendingScrollMsgIdRef]);

  useEffect(() => {
    const msgIdSet = new Set(messages.map((message) => message.msg_id));
    const rootIdCache = new Map<string, string>();
    function getRootId(msgId: string): string {
      if (rootIdCache.has(msgId)) return rootIdCache.get(msgId)!;
      const message = messages.find((item) => item.msg_id === msgId);
      if (!message || !isMsgReply(message, msgIdSet) || !message.in_reply_to_msg_id) {
        rootIdCache.set(msgId, msgId);
        return msgId;
      }
      const rootId = getRootId(message.in_reply_to_msg_id);
      rootIdCache.set(msgId, rootId);
      return rootId;
    }
    const toExpand = messages
      .filter((message) => isMsgReply(message, msgIdSet) && message._streaming)
      .map((message) => getRootId(message.msg_id));
    if (toExpand.length > 0) {
      setExpandedTopics((prev) => new Set([...prev, ...toExpand]));
    }
  }, [messages, setExpandedTopics]);

  const { topicRoots, topicRepliesOf } = useMemo(
    () => buildTopicTree(messages, isDmSelected),
    [isDmSelected, messages],
  );

  const msgById = useMemo(
    () => new Map(messages.map((message) => [message.msg_id, message])),
    [messages],
  );

  const clarifyAnsweredParentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      if (
        message.in_reply_to_msg_id &&
        isClarifyReplyUserMessage(message.content)
      ) {
        ids.add(message.in_reply_to_msg_id);
      }
    }
    return ids;
  }, [messages]);

  const rowVirtualizer = useVirtualizer({
    count: topicRoots.length,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize: () => VIRTUAL_MESSAGE_ESTIMATED_HEIGHT,
    overscan: VIRTUAL_MESSAGE_OVERSCAN_ROWS,
    isScrollingResetDelay: 120,
    useAnimationFrameWithResizeObserver: true,
    getItemKey: (index) => topicRoots[index]?.msg_id ?? index,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  useLayoutEffect(() => {
    if (!messagesContainerRef.current || isLoadingOlderRef.current) return;
    if (!selectedId || topicRoots.length === 0) return;
    const container = messagesContainerRef.current;
    const channelChanged = lastAutoScrollChannelRef.current !== selectedId;
    lastAutoScrollChannelRef.current = selectedId;
    if (!channelChanged && !stickToBottomRef.current) return;

    rowVirtualizer.scrollToIndex(topicRoots.length - 1, { align: "end" });
    container.scrollTop = container.scrollHeight;
    stickToBottomRef.current = true;
  }, [messages.length, rowVirtualizer, selectedId, topicRoots.length]);

  const pageTopicSourceMessages = useMemo(
    () => mergeMessagesChronologically(messages, pageTopicMessages),
    [messages, pageTopicMessages],
  );
  const { topicRepliesOf: pageTopicRepliesOf } = useMemo(
    () => buildTopicTree(pageTopicSourceMessages, false),
    [pageTopicSourceMessages],
  );

  return {
    messageStore,
    setMessageStore,
    messages,
    setMessages,
    loading,
    hasMore,
    loadingMore,
    messagesContainerRef,
    handleMessagesScroll,
    topicRoots,
    topicRepliesOf,
    msgById,
    clarifyAnsweredParentIds,
    rowVirtualizer,
    virtualItems,
    pageTopicSourceMessages,
    pageTopicRepliesOf,
    preloadChannelMessages,
  };
}
