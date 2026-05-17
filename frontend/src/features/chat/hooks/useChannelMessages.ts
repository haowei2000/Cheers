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
const JUMP_TO_BOTTOM_BOTTOM_GAP = 240;
const JUMP_TO_BOTTOM_SCROLL_DISTANCE = 140;
const JUMP_TO_BOTTOM_SETTLE_FRAMES = 12;
const STICK_TO_BOTTOM_GAP = 160;

interface UseChannelMessagesOptions {
  selectedId: string | null;
  isDmSelected: boolean;
  currentUserId: string | null;
  authFetch: AuthFetch;
  selectedIdRef: MutableRefObject<string | null>;
  pendingScrollMsgIdRef: MutableRefObject<string | null>;
  pageTopicMessages: Message[];
  setExpandedTopics: Dispatch<SetStateAction<Set<string>>>;
}

type ChannelMessageCacheEntry = {
  store: MessageStore;
  hasMore: boolean;
  hasMoreAfter: boolean;
  receivedAt: number;
  anchorId: string | null;
};

type ChannelScrollPosition = {
  msgId: string;
  offsetTop: number;
  savedAt?: number;
};

type InitialScrollTarget = {
  channelId: string;
  msgId: string | null;
  align: "offset" | "center" | "bottom";
  offsetTop?: number;
};

const CHANNEL_POSITION_STORAGE_PREFIX = "agentnexus.channel-position.v2";
const LEGACY_CHANNEL_POSITION_STORAGE_PREFIX = "agentnexus.channel-position.v1";
const DEFAULT_ANCHOR_OFFSET_TOP = 96;
const READING_ANCHOR_VIEWPORT_RATIO = 0.42;
const INITIAL_SCROLL_SETTLE_FRAMES = 6;
const PREPEND_SCROLL_SETTLE_FRAMES = 3;
const POSITION_SAVE_MIN_INTERVAL_MS = 500;

function positionStorageKey(prefix: string, userId: string, channelId: string): string {
  return `${prefix}:${userId}:${channelId}`;
}

function readSavedChannelPosition(userId: string | null, channelId: string): ChannelScrollPosition | null {
  if (!userId) return null;
  try {
    const raw =
      localStorage.getItem(positionStorageKey(CHANNEL_POSITION_STORAGE_PREFIX, userId, channelId)) ??
      localStorage.getItem(positionStorageKey(LEGACY_CHANNEL_POSITION_STORAGE_PREFIX, userId, channelId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      msg_id?: unknown;
      offset_top?: unknown;
      saved_at?: unknown;
    };
    if (typeof parsed.msg_id !== "string" || !parsed.msg_id) return null;
    const offsetTop =
      typeof parsed.offset_top === "number" && Number.isFinite(parsed.offset_top)
        ? parsed.offset_top
        : DEFAULT_ANCHOR_OFFSET_TOP;
    return {
      msgId: parsed.msg_id,
      offsetTop: Math.max(0, offsetTop),
      savedAt:
        typeof parsed.saved_at === "number" && Number.isFinite(parsed.saved_at)
          ? parsed.saved_at
          : undefined,
    };
  } catch {
    return null;
  }
}

function writeSavedChannelPosition(
  userId: string | null,
  channelId: string,
  position: ChannelScrollPosition,
): void {
  if (!userId || !channelId || !position.msgId) return;
  try {
    localStorage.setItem(
      positionStorageKey(CHANNEL_POSITION_STORAGE_PREFIX, userId, channelId),
      JSON.stringify({
        msg_id: position.msgId,
        offset_top: Math.max(0, Math.round(position.offsetTop)),
        saved_at: Date.now(),
      }),
    );
  } catch {
    /* localStorage can be unavailable in private or constrained contexts. */
  }
}

function fetchKey(channelId: string, anchorId: string | null): string {
  return `${channelId}:${anchorId || "bottom"}`;
}

function messageAnchorNodes(container: HTMLElement): HTMLElement[] {
  const anchorRows = Array.from(
    container.querySelectorAll<HTMLElement>("[data-message-anchor-id]"),
  );
  if (anchorRows.length > 0) return anchorRows;
  return Array.from(container.querySelectorAll<HTMLElement>('[id^="msg-"]'));
}

function messageAnchorId(node: HTMLElement): string | null {
  return node.dataset.messageAnchorId || (node.id.startsWith("msg-") ? node.id.slice(4) : null);
}

function findMessageAnchorNode(container: HTMLElement, msgId: string): HTMLElement | null {
  for (const node of messageAnchorNodes(container)) {
    if (messageAnchorId(node) === msgId) return node;
  }
  return document.getElementById(`msg-${msgId}`);
}

function findVisibleMessageAnchor(container: HTMLElement | null): ChannelScrollPosition | null {
  if (!container) return null;
  const containerRect = container.getBoundingClientRect();
  const anchorY = containerRect.top + containerRect.height * READING_ANCHOR_VIEWPORT_RATIO;
  const nodes = messageAnchorNodes(container);
  let best: ChannelScrollPosition | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const node of nodes) {
    const msgId = messageAnchorId(node);
    if (!msgId) continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue;
    const distance = Math.abs(rect.top - anchorY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = {
        msgId,
        offsetTop: rect.top - containerRect.top,
      };
    }
  }

  return best;
}

function settleMessageAnchor(
  container: HTMLElement,
  target: Pick<InitialScrollTarget, "msgId" | "align" | "offsetTop">,
  onSettled: () => void,
  frames = INITIAL_SCROLL_SETTLE_FRAMES,
): void {
  let remaining = frames;

  const apply = () => {
    if (!target.msgId) {
      onSettled();
      return;
    }
    const node = findMessageAnchorNode(container, target.msgId);
    if (!node) {
      if (remaining > 0) {
        remaining -= 1;
        requestAnimationFrame(apply);
        return;
      }
      onSettled();
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const desiredOffset =
      target.align === "center"
        ? Math.max(24, (containerRect.height - rect.height) / 2)
        : Math.max(0, target.offsetTop ?? DEFAULT_ANCHOR_OFFSET_TOP);
    const delta = rect.top - containerRect.top - desiredOffset;
    if (Math.abs(delta) > 1) {
      container.scrollTop += delta;
    }

    if (remaining > 0) {
      remaining -= 1;
      requestAnimationFrame(apply);
      return;
    }
    onSettled();
  };

  requestAnimationFrame(apply);
}

export function useChannelMessages({
  selectedId,
  isDmSelected,
  currentUserId,
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
  const [hasMoreNewer, setHasMoreNewer] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [restoringInitialScroll, setRestoringInitialScrollState] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const isLoadingOlderRef = useRef(false);
  const isLoadingNewerRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const lastAutoScrollChannelRef = useRef<string | null>(null);
  const channelMessageCacheRef = useRef<Partial<Record<string, ChannelMessageCacheEntry>>>({});
  const preloadRequestsRef = useRef<Partial<Record<string, Promise<ChannelMessageCacheEntry | null>>>>({});
  const cacheGenerationRef = useRef(0);
  const showJumpToBottomRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const lastSavedPositionRef = useRef<{
    channelId: string;
    msgId: string;
    offsetTop: number;
    savedAt: number;
  } | null>(null);
  const downwardScrollDistanceRef = useRef(0);
  const jumpToBottomRafRef = useRef<number | null>(null);
  const restoringInitialScrollRef = useRef(false);
  const initialScrollTargetRef = useRef<InitialScrollTarget | null>(null);

  const setRestoringInitialScroll = useCallback((value: boolean) => {
    if (restoringInitialScrollRef.current === value) return;
    restoringInitialScrollRef.current = value;
    setRestoringInitialScrollState(value);
  }, []);

  const setJumpToBottomVisible = useCallback((visible: boolean) => {
    if (showJumpToBottomRef.current === visible) return;
    showJumpToBottomRef.current = visible;
    setShowJumpToBottom(visible);
  }, []);

  const cancelJumpToBottomRaf = useCallback(() => {
    if (jumpToBottomRafRef.current === null) return;
    cancelAnimationFrame(jumpToBottomRafRef.current);
    jumpToBottomRafRef.current = null;
  }, []);

  const fetchInitialMessages = useCallback(
    async (
      channelId: string,
      anchorId?: string | null,
      signal?: AbortSignal,
    ): Promise<ChannelMessageCacheEntry> => {
      const params = new URLSearchParams({
        limit: String(INITIAL_MESSAGE_PAGE_SIZE),
      });
      if (anchorId) params.set("around_id", anchorId);
      const response = await authFetch(
        `${API}/channels/${channelId}/messages?${params.toString()}`,
        signal ? { signal } : undefined,
      );
      const data = await response.json();
      const items = data.data || [];
      const visibleData = trimToRecentMessages(items);
      const resolvedAnchorId =
        anchorId &&
        data.meta?.anchor_found !== false &&
        visibleData.some((message) => message.msg_id === anchorId)
          ? anchorId
          : null;
      return {
        store: messagesToStore(visibleData),
        hasMore:
          Boolean(
            data.meta?.has_more_before ??
              data.meta?.has_more ??
              items.length >= INITIAL_MESSAGE_PAGE_SIZE,
          ) &&
          visibleData.length < MAX_LOADED_MESSAGES,
        hasMoreAfter: Boolean(data.meta?.has_more_after) && visibleData.length < MAX_LOADED_MESSAGES,
        receivedAt: Date.now(),
        anchorId: resolvedAnchorId,
      };
    },
    [authFetch],
  );

  const preloadChannelMessages = useCallback(
    (channelId: string) => {
      const anchorId = readSavedChannelPosition(currentUserId, channelId)?.msgId ?? null;
      const requestKey = fetchKey(channelId, anchorId);
      if (
        !channelId ||
        channelMessageCacheRef.current[channelId]?.store.byId[anchorId || ""] ||
        (!anchorId && channelMessageCacheRef.current[channelId]) ||
        preloadRequestsRef.current[requestKey]
      ) {
        return;
      }
      const generation = cacheGenerationRef.current;
      const request = fetchInitialMessages(channelId, anchorId)
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
          delete preloadRequestsRef.current[requestKey];
        });
      preloadRequestsRef.current[requestKey] = request;
    },
    [currentUserId, fetchInitialMessages],
  );

  useEffect(() => {
    cacheGenerationRef.current += 1;
    channelMessageCacheRef.current = {};
    preloadRequestsRef.current = {};
  }, [authFetch]);

  useEffect(() => cancelJumpToBottomRaf, [cancelJumpToBottomRaf]);

  useLayoutEffect(() => {
    if (!selectedId) {
      cancelJumpToBottomRaf();
      setMessageStore(emptyMessageStore());
      setHasMore(true);
      setHasMoreNewer(false);
      setLoading(false);
      setRestoringInitialScroll(false);
      setJumpToBottomVisible(false);
      return;
    }
    const targetChannelId = selectedId;
    const controller = new AbortController();
    const pendingAnchorId = pendingScrollMsgIdRef.current;
    if (pendingAnchorId) {
      pendingScrollMsgIdRef.current = null;
    }
    const savedPosition = pendingAnchorId
      ? null
      : readSavedChannelPosition(currentUserId, targetChannelId);
    const savedAnchorId = pendingAnchorId || savedPosition?.msgId || null;
    const requestKey = fetchKey(targetChannelId, savedAnchorId);
    const cached = channelMessageCacheRef.current[targetChannelId];
    const cachedMatchesAnchor = cached && (!savedAnchorId || cached.store.byId[savedAnchorId]);
    stickToBottomRef.current = !savedAnchorId;
    initialScrollTargetRef.current = {
      channelId: targetChannelId,
      msgId: savedAnchorId,
      align: pendingAnchorId ? "center" : savedAnchorId ? "offset" : "bottom",
      offsetTop: savedPosition?.offsetTop,
    };
    lastAutoScrollChannelRef.current = null;
    lastScrollTopRef.current = 0;
    downwardScrollDistanceRef.current = 0;
    lastSavedPositionRef.current = null;
    cancelJumpToBottomRaf();
    setRestoringInitialScroll(true);
    setJumpToBottomVisible(false);
    if (cached && cachedMatchesAnchor) {
      setMessageStore(cached.store);
      setHasMore(cached.hasMore);
      setHasMoreNewer(cached.hasMoreAfter);
      setLoading(false);
      if (cached.store.ids.length === 0) {
        setRestoringInitialScroll(false);
      }
    } else {
      setMessageStore(emptyMessageStore());
      setHasMore(true);
      setHasMoreNewer(false);
      setLoading(true);
    }

    if (cached && cachedMatchesAnchor && Date.now() - cached.receivedAt < CHANNEL_CACHE_REVALIDATE_MS) {
      return () => controller.abort();
    }

    const request =
      preloadRequestsRef.current[requestKey] ??
      fetchInitialMessages(targetChannelId, savedAnchorId, controller.signal);

    request
      .then((entry) => {
        if (!entry) return;
        if (
          controller.signal.aborted ||
          selectedIdRef.current !== targetChannelId
        ) {
          return;
        }
        initialScrollTargetRef.current = {
          channelId: targetChannelId,
          msgId: entry.anchorId,
          align: pendingAnchorId ? "center" : entry.anchorId ? "offset" : "bottom",
          offsetTop:
            entry.anchorId && entry.anchorId === savedPosition?.msgId
              ? savedPosition.offsetTop
              : undefined,
        };
        stickToBottomRef.current = !entry.anchorId;
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
        setHasMoreNewer(entry.hasMoreAfter);
        if (entry.store.ids.length === 0) {
          setRestoringInitialScroll(false);
        }
      })
      .catch((error) => {
        if ((error as { name?: string }).name === "AbortError") return;
        if (selectedIdRef.current !== targetChannelId) return;
        console.error(error);
        setRestoringInitialScroll(false);
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
  }, [
    cancelJumpToBottomRaf,
    currentUserId,
    fetchInitialMessages,
    pendingScrollMsgIdRef,
    selectedId,
    selectedIdRef,
    setRestoringInitialScroll,
    setJumpToBottomVisible,
  ]);

  useEffect(() => {
    if (!selectedId || loading) return;
    channelMessageCacheRef.current[selectedId] = {
      store: messageStore,
      hasMore,
      hasMoreAfter: hasMoreNewer,
      receivedAt: Date.now(),
      anchorId: readSavedChannelPosition(currentUserId, selectedId)?.msgId ?? null,
    };
  }, [currentUserId, hasMore, hasMoreNewer, loading, messageStore, selectedId]);

  const persistCurrentChannelPosition = useCallback(
    (channelId: string | null = selectedId, force = false) => {
      if (!channelId || !currentUserId) return;
      const position = findVisibleMessageAnchor(messagesContainerRef.current);
      if (!position) return;
      const now = Date.now();
      const lastSaved = lastSavedPositionRef.current;
      if (
        !force &&
        lastSaved?.channelId === channelId &&
        lastSaved.msgId === position.msgId &&
        Math.abs(lastSaved.offsetTop - position.offsetTop) < 2
      ) {
        return;
      }
      if (!force && lastSaved && now - lastSaved.savedAt < POSITION_SAVE_MIN_INTERVAL_MS) {
        return;
      }
      writeSavedChannelPosition(currentUserId, channelId, position);
      lastSavedPositionRef.current = {
        channelId,
        msgId: position.msgId,
        offsetTop: position.offsetTop,
        savedAt: now,
      };
    },
    [currentUserId, selectedId],
  );

  useEffect(() => {
    return () => {
      persistCurrentChannelPosition(selectedId, true);
    };
  }, [persistCurrentChannelPosition, selectedId]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      persistCurrentChannelPosition(selectedId, true);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [persistCurrentChannelPosition, selectedId]);

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
    const prevScrollTop = container?.scrollTop ?? 0;
    const scrollAnchor = findVisibleMessageAnchor(container);
    try {
      const response = await authFetch(
        `${API}/channels/${targetChannelId}/messages?before_id=${oldest.msg_id}&limit=${OLDER_MESSAGE_PAGE_SIZE}`,
      );
      const data = await response.json();
      const older = data.data || [];
      if (older.length === 0) {
        setHasMore(false);
        isLoadingOlderRef.current = false;
        return;
      }
      if (selectedIdRef.current !== targetChannelId) {
        isLoadingOlderRef.current = false;
        return;
      }
      const hitWindowCap =
        messages.length + older.length >= MAX_LOADED_MESSAGES;
      setHasMore(
        !hitWindowCap &&
          Boolean(
            data.meta?.has_more_before ??
              data.meta?.has_more ??
              older.length >= OLDER_MESSAGE_PAGE_SIZE,
          ),
      );
      setMessageStore((prev) =>
        trimMessageStoreToRecent(
          messagesToStore([...older, ...storeToMessages(prev)]),
          MAX_LOADED_MESSAGES,
        ),
      );
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
          stickToBottomRef.current =
            container.scrollHeight - container.scrollTop - container.clientHeight <
            STICK_TO_BOTTOM_GAP;
          if (scrollAnchor) {
            settleMessageAnchor(
              container,
              {
                msgId: scrollAnchor.msgId,
                align: "offset",
                offsetTop: scrollAnchor.offsetTop,
              },
              () => {
                isLoadingOlderRef.current = false;
              },
              PREPEND_SCROLL_SETTLE_FRAMES,
            );
            return;
          }
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

  const loadNewerMessages = useCallback(async () => {
    if (!selectedId || !hasMoreNewer || loadingNewer) return;
    const targetChannelId = selectedId;
    const newest = messages[messages.length - 1];
    if (!newest) return;
    setLoadingNewer(true);
    isLoadingNewerRef.current = true;
    try {
      const response = await authFetch(
        `${API}/channels/${targetChannelId}/messages?after_id=${newest.msg_id}&limit=${OLDER_MESSAGE_PAGE_SIZE}`,
      );
      const data = await response.json();
      const newer = data.data || [];
      if (newer.length === 0) {
        setHasMoreNewer(false);
        return;
      }
      if (selectedIdRef.current !== targetChannelId) return;
      setHasMoreNewer(
        Boolean(
          data.meta?.has_more_after ??
            data.meta?.has_more ??
            newer.length >= OLDER_MESSAGE_PAGE_SIZE,
        ),
      );
      setMessageStore((prev) =>
        trimMessageStoreToRecent(
          messagesToStore([...storeToMessages(prev), ...newer]),
          MAX_LOADED_MESSAGES,
        ),
      );
    } catch (error) {
      console.error(error);
    } finally {
      isLoadingNewerRef.current = false;
      setLoadingNewer(false);
    }
  }, [authFetch, hasMoreNewer, loadingNewer, messages, selectedId, selectedIdRef]);

  const handleMessagesScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      const scrollTop = target.scrollTop;
      const bottomGap = target.scrollHeight - scrollTop - target.clientHeight;
      const nearBottom = bottomGap < STICK_TO_BOTTOM_GAP;
      const delta = scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;
      stickToBottomRef.current = nearBottom;

      if (restoringInitialScrollRef.current) {
        return;
      }

      if (nearBottom) {
        downwardScrollDistanceRef.current = 0;
        setJumpToBottomVisible(false);
      } else if (delta > 0) {
        downwardScrollDistanceRef.current += delta;
        if (
          bottomGap > JUMP_TO_BOTTOM_BOTTOM_GAP &&
          downwardScrollDistanceRef.current > JUMP_TO_BOTTOM_SCROLL_DISTANCE
        ) {
          setJumpToBottomVisible(true);
        }
      } else if (delta < -8) {
        downwardScrollDistanceRef.current = 0;
        setJumpToBottomVisible(false);
      }

      if (target.scrollTop < 100 && hasMore && !loadingMore) {
        loadMoreMessages();
      }
      if (bottomGap < 100 && hasMoreNewer && !loadingNewer) {
        loadNewerMessages();
      }
      persistCurrentChannelPosition(selectedId, false);
    },
    [
      hasMore,
      hasMoreNewer,
      loadingMore,
      loadingNewer,
      loadMoreMessages,
      loadNewerMessages,
      persistCurrentChannelPosition,
      selectedId,
      setJumpToBottomVisible,
    ],
  );

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const updateMetrics = () => {
      const wasStuckToBottom = stickToBottomRef.current;
      stickToBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < STICK_TO_BOTTOM_GAP;
      if (wasStuckToBottom && !isLoadingOlderRef.current) {
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
          stickToBottomRef.current = true;
          setJumpToBottomVisible(false);
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

  const jumpToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    cancelJumpToBottomRaf();
    downwardScrollDistanceRef.current = 0;
    setJumpToBottomVisible(false);
    stickToBottomRef.current = true;
    if (topicRoots.length > 0) {
      rowVirtualizer.scrollToIndex(topicRoots.length - 1, { align: "end" });
    }

    const settleToBottom = (remainingFrames: number) => {
      const nextContainer = messagesContainerRef.current;
      if (!nextContainer) return;
      if (topicRoots.length > 0) {
        rowVirtualizer.scrollToIndex(topicRoots.length - 1, { align: "end" });
      }
      nextContainer.scrollTop = Math.max(
        0,
        nextContainer.scrollHeight - nextContainer.clientHeight,
      );
      lastScrollTopRef.current = nextContainer.scrollTop;
      const bottomGap =
        nextContainer.scrollHeight -
        nextContainer.scrollTop -
        nextContainer.clientHeight;
      if (bottomGap > 1 && remainingFrames > 0) {
        jumpToBottomRafRef.current = requestAnimationFrame(() =>
          settleToBottom(remainingFrames - 1),
        );
        return;
      }
      jumpToBottomRafRef.current = null;
      stickToBottomRef.current = true;
      setJumpToBottomVisible(false);
    };

    jumpToBottomRafRef.current = requestAnimationFrame(() =>
      settleToBottom(JUMP_TO_BOTTOM_SETTLE_FRAMES),
    );
  }, [cancelJumpToBottomRaf, rowVirtualizer, setJumpToBottomVisible, topicRoots.length]);

  useLayoutEffect(() => {
    if (!messagesContainerRef.current || isLoadingOlderRef.current) return;
    if (!selectedId || topicRoots.length === 0) return;
    const container = messagesContainerRef.current;
    const channelChanged = lastAutoScrollChannelRef.current !== selectedId;
    lastAutoScrollChannelRef.current = selectedId;
    const initialTarget = initialScrollTargetRef.current;

    const finishInitialPlacement = () => {
      if (selectedIdRef.current !== selectedId) return;
      lastScrollTopRef.current = container.scrollTop;
      setRestoringInitialScroll(false);
      requestAnimationFrame(() => {
        if (selectedIdRef.current === selectedId) {
          persistCurrentChannelPosition(selectedId, true);
        }
      });
    };

    if (channelChanged && initialTarget?.channelId === selectedId) {
      initialScrollTargetRef.current = null;
      if (initialTarget.align !== "bottom" && initialTarget.msgId) {
        const targetIndex = topicRoots.findIndex(
          (message) => message.msg_id === initialTarget.msgId,
        );
        if (targetIndex >= 0) {
          rowVirtualizer.scrollToIndex(targetIndex, {
            align: initialTarget.align === "center" ? "center" : "start",
          });
        } else {
          const messageIndex = messages.findIndex(
            (message) => message.msg_id === initialTarget.msgId,
          );
          if (messageIndex >= 0) {
            container.scrollTop = Math.max(
              0,
              messageIndex * VIRTUAL_MESSAGE_ESTIMATED_HEIGHT - container.clientHeight / 2,
            );
          }
        }
        stickToBottomRef.current = false;
        setJumpToBottomVisible(false);
        settleMessageAnchor(container, initialTarget, finishInitialPlacement);
        return;
      }
    }
    if (!channelChanged && !stickToBottomRef.current) return;

    rowVirtualizer.scrollToIndex(topicRoots.length - 1, { align: "end" });
    container.scrollTop = container.scrollHeight;
    stickToBottomRef.current = true;
    setJumpToBottomVisible(false);
    if (channelChanged) {
      finishInitialPlacement();
    } else {
      requestAnimationFrame(() => {
        persistCurrentChannelPosition(selectedId, true);
      });
    }
  }, [
    messages,
    persistCurrentChannelPosition,
    rowVirtualizer,
    selectedId,
    selectedIdRef,
    setRestoringInitialScroll,
    setJumpToBottomVisible,
    topicRoots,
    topicRoots.length,
  ]);

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
    restoringInitialScroll,
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
    showJumpToBottom,
    jumpToBottom,
    pageTopicSourceMessages,
    pageTopicRepliesOf,
    preloadChannelMessages,
  };
}
