import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction, UIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/react-virtual";
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

type ChannelWindowState = {
  channelId: string | null;
  store: MessageStore;
  hasMore: boolean;
  hasMoreAfter: boolean;
  loading: boolean;
  anchorId: string | null;
};

type ChannelScrollPosition = {
  msgId: string;
  offsetTop: number;
};

type InitialScrollTarget = {
  channelId: string;
  msgId: string | null;
  align: "offset" | "center" | "bottom";
  offsetTop?: number;
};

const DEFAULT_ANCHOR_OFFSET_TOP = 96;
const READING_ANCHOR_VIEWPORT_RATIO = 0.42;
const INITIAL_SCROLL_SETTLE_FRAMES = 2;
const EXPLICIT_SCROLL_SETTLE_FRAMES = 3;
const PREPEND_SCROLL_SETTLE_FRAMES = 2;
const PAGINATION_EDGE_PX = VIRTUAL_MESSAGE_ESTIMATED_HEIGHT * 2;
const EMPTY_MESSAGE_STORE = emptyMessageStore();

function fetchKey(channelId: string, anchorId: string | null): string {
  return `${channelId}:${anchorId || "bottom"}`;
}

function emptyChannelWindowState(): ChannelWindowState {
  return {
    channelId: null,
    store: emptyMessageStore(),
    hasMore: true,
    hasMoreAfter: false,
    loading: false,
    anchorId: null,
  };
}

function cacheEntryToWindowState(
  channelId: string,
  entry: ChannelMessageCacheEntry,
  loading = false,
): ChannelWindowState {
  return {
    channelId,
    store: entry.store,
    hasMore: entry.hasMore,
    hasMoreAfter: entry.hasMoreAfter,
    loading,
    anchorId: entry.anchorId,
  };
}

function windowStateToCacheEntry(state: ChannelWindowState): ChannelMessageCacheEntry {
  return {
    store: state.store,
    hasMore: state.hasMore,
    hasMoreAfter: state.hasMoreAfter,
    receivedAt: Date.now(),
    anchorId: state.anchorId,
  };
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

function findVirtualVisibleMessageAnchor(
  container: HTMLElement | null,
  virtualItems: VirtualItem[],
  topicRoots: Message[],
): ChannelScrollPosition | null {
  if (!container || virtualItems.length === 0) return null;
  const scrollTop = container.scrollTop;
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + container.clientHeight;
  const targetY = scrollTop + container.clientHeight * READING_ANCHOR_VIEWPORT_RATIO;
  let best: ChannelScrollPosition | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const item of virtualItems) {
    if (item.end < viewportTop || item.start > viewportBottom) continue;
    const message = topicRoots[item.index];
    if (!message) continue;
    const distance = Math.abs(item.start - targetY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = {
        msgId: message.msg_id,
        offsetTop: item.start - scrollTop,
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
      container.scrollBy(0, delta);
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
  authFetch,
  selectedIdRef,
  pendingScrollMsgIdRef,
  pageTopicMessages,
  setExpandedTopics,
}: UseChannelMessagesOptions) {
  const [windowState, setWindowState] = useState<ChannelWindowState>(() =>
    emptyChannelWindowState(),
  );
  const messageStore =
    selectedId && windowState.channelId === selectedId
      ? windowState.store
      : EMPTY_MESSAGE_STORE;
  const messages = useMemo(() => storeToMessages(messageStore), [messageStore]);
  const loading = selectedId
    ? windowState.channelId !== selectedId || windowState.loading
    : false;
  const hasMore =
    selectedId && windowState.channelId === selectedId
      ? windowState.hasMore
      : true;
  const hasMoreNewer =
    selectedId && windowState.channelId === selectedId
      ? windowState.hasMoreAfter
      : false;
  const setMessageStore = useCallback(
    (next: SetStateAction<MessageStore>) => {
      setWindowState((prev) => {
        if (!selectedId || prev.channelId !== selectedId) return prev;
        const nextStore =
          typeof next === "function"
            ? (next as (prev: MessageStore) => MessageStore)(prev.store)
            : next;
        return {
          ...prev,
          store: nextStore,
        };
      });
    },
    [selectedId],
  );
  const setMessages = useCallback(
    (next: Message[] | ((prev: Message[]) => Message[])) => {
      setWindowState((prevState) => {
        if (!selectedId || prevState.channelId !== selectedId) {
          if (typeof next === "function") return prevState;
          return {
            ...prevState,
            channelId: selectedId,
            store: messagesToStore(next),
          };
        }
        if (typeof next !== "function") {
          return {
            ...prevState,
            store: messagesToStore(next),
          };
        }
        const prevMessages = storeToMessages(prevState.store);
        return {
          ...prevState,
          store: messagesToStore(next(prevMessages)),
        };
      });
    },
    [selectedId],
  );
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
  const downwardScrollDistanceRef = useRef(0);
  const jumpToBottomRafRef = useRef<number | null>(null);
  const restoringInitialScrollRef = useRef(false);
  const suppressInitialScrollEventsRef = useRef(false);
  const initialScrollTargetRef = useRef<InitialScrollTarget | null>(null);
  const latestTopicRootsRef = useRef<Message[]>([]);
  const latestVirtualItemsRef = useRef<VirtualItem[]>([]);

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
      const anchorId = null;
      const requestKey = fetchKey(channelId, anchorId);
      const cached = channelMessageCacheRef.current[channelId];
      if (
        !channelId ||
        cached?.anchorId === null ||
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
    [fetchInitialMessages],
  );

  const ensureMessageLoaded = useCallback(
    async (msgId: string): Promise<boolean> => {
      if (!selectedId || !msgId) return false;
      if (messageStore.byId[msgId]) return true;

      const targetChannelId = selectedId;
      suppressInitialScrollEventsRef.current = true;
      setRestoringInitialScroll(true);
      setJumpToBottomVisible(false);

      try {
        const entry = await fetchInitialMessages(targetChannelId, msgId);
        if (selectedIdRef.current !== targetChannelId) return false;

        initialScrollTargetRef.current = {
          channelId: targetChannelId,
          msgId: entry.anchorId,
          align: entry.anchorId ? "center" : "bottom",
        };
        lastAutoScrollChannelRef.current = null;
        stickToBottomRef.current = !entry.anchorId;
        channelMessageCacheRef.current[targetChannelId] = entry;
        setWindowState(cacheEntryToWindowState(targetChannelId, entry));
        if (entry.store.ids.length === 0) {
          suppressInitialScrollEventsRef.current = false;
          setRestoringInitialScroll(false);
        }
        return Boolean(entry.anchorId);
      } catch (error) {
        console.error(error);
        if (selectedIdRef.current === targetChannelId) {
          suppressInitialScrollEventsRef.current = false;
          setRestoringInitialScroll(false);
        }
        return false;
      }
    },
    [
      fetchInitialMessages,
      messageStore.byId,
      selectedId,
      selectedIdRef,
      setJumpToBottomVisible,
      setRestoringInitialScroll,
    ],
  );

  useEffect(() => {
    cacheGenerationRef.current += 1;
    channelMessageCacheRef.current = {};
    preloadRequestsRef.current = {};
  }, [authFetch]);

  useEffect(() => {
    return () => {
      cancelJumpToBottomRaf();
    };
  }, [cancelJumpToBottomRaf]);

  useEffect(() => {
    if (!selectedId) {
      cancelJumpToBottomRaf();
      setWindowState(emptyChannelWindowState());
      suppressInitialScrollEventsRef.current = false;
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
    const requestedAnchorId = pendingAnchorId || null;
    const requestKey = fetchKey(targetChannelId, requestedAnchorId);
    const cached = channelMessageCacheRef.current[targetChannelId];
    const cachedMatchesAnchor =
      cached &&
      (requestedAnchorId
        ? cached.anchorId === requestedAnchorId && cached.store.byId[requestedAnchorId]
        : cached.anchorId === null);
    stickToBottomRef.current = !requestedAnchorId;
    initialScrollTargetRef.current = {
      channelId: targetChannelId,
      msgId: requestedAnchorId,
      align: requestedAnchorId ? "center" : "bottom",
    };
    lastAutoScrollChannelRef.current = null;
    lastScrollTopRef.current = 0;
    downwardScrollDistanceRef.current = 0;
    cancelJumpToBottomRaf();
    suppressInitialScrollEventsRef.current = true;
    setRestoringInitialScroll(Boolean(requestedAnchorId));
    setJumpToBottomVisible(false);
    if (cached && cachedMatchesAnchor) {
      setWindowState(cacheEntryToWindowState(targetChannelId, cached));
      if (cached.store.ids.length === 0) {
        suppressInitialScrollEventsRef.current = false;
        setRestoringInitialScroll(false);
      }
    } else {
      setWindowState({
        channelId: targetChannelId,
        store: emptyMessageStore(),
        hasMore: true,
        hasMoreAfter: false,
        loading: true,
        anchorId: null,
      });
    }

    if (cached && cachedMatchesAnchor && Date.now() - cached.receivedAt < CHANNEL_CACHE_REVALIDATE_MS) {
      return () => controller.abort();
    }

    const request =
      preloadRequestsRef.current[requestKey] ??
      fetchInitialMessages(targetChannelId, requestedAnchorId, controller.signal);

    request
      .then((entry) => {
        if (!entry) {
          suppressInitialScrollEventsRef.current = false;
          setRestoringInitialScroll(false);
          return;
        }
        if (
          controller.signal.aborted ||
          selectedIdRef.current !== targetChannelId
        ) {
          return;
        }
        initialScrollTargetRef.current = {
          channelId: targetChannelId,
          msgId: entry.anchorId,
          align: requestedAnchorId && entry.anchorId ? "center" : "bottom",
        };
        stickToBottomRef.current = !entry.anchorId;
        channelMessageCacheRef.current[targetChannelId] = entry;
        setWindowState((prev) => {
          if (prev.channelId !== targetChannelId) return prev;
          const prevMessages = storeToMessages(prev.store);
          const store =
            prevMessages.length === 0
              ? entry.store
              : messagesToStore(
                  trimToRecentMessages(
                    mergeMessagesChronologically(prevMessages, storeToMessages(entry.store)),
                  ),
                );
          return {
            channelId: targetChannelId,
            store,
            hasMore: entry.hasMore,
            hasMoreAfter: entry.hasMoreAfter,
            loading: false,
            anchorId: entry.anchorId,
          };
        });
        if (entry.store.ids.length === 0) {
          suppressInitialScrollEventsRef.current = false;
          setRestoringInitialScroll(false);
        }
      })
      .catch((error) => {
        if ((error as { name?: string }).name === "AbortError") return;
        if (selectedIdRef.current !== targetChannelId) return;
        console.error(error);
        suppressInitialScrollEventsRef.current = false;
        setRestoringInitialScroll(false);
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          selectedIdRef.current === targetChannelId
        ) {
          setWindowState((prev) =>
            prev.channelId === targetChannelId
              ? { ...prev, loading: false }
              : prev,
          );
        }
      });

    return () => controller.abort();
  }, [
    cancelJumpToBottomRaf,
    fetchInitialMessages,
    pendingScrollMsgIdRef,
    selectedId,
    selectedIdRef,
    setRestoringInitialScroll,
    setJumpToBottomVisible,
  ]);

  useEffect(() => {
    if (!selectedId || windowState.channelId !== selectedId || windowState.loading) return;
    channelMessageCacheRef.current[selectedId] = windowStateToCacheEntry(windowState);
  }, [selectedId, windowState]);

  const loadMoreMessages = useCallback(async () => {
    if (!selectedId || !hasMore || loadingMore) return;
    if (messages.length >= MAX_LOADED_MESSAGES) {
      const targetChannelId = selectedId;
      setWindowState((prev) =>
        prev.channelId === targetChannelId ? { ...prev, hasMore: false } : prev,
      );
      return;
    }
    const targetChannelId = selectedId;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingMore(true);
    isLoadingOlderRef.current = true;
    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    const scrollAnchor =
      findVirtualVisibleMessageAnchor(
        container,
        latestVirtualItemsRef.current,
        latestTopicRootsRef.current,
      ) ?? findVisibleMessageAnchor(container);
    try {
      const response = await authFetch(
        `${API}/channels/${targetChannelId}/messages?before_id=${oldest.msg_id}&limit=${OLDER_MESSAGE_PAGE_SIZE}`,
      );
      const data = await response.json();
      const older = data.data || [];
      if (older.length === 0) {
        setWindowState((prev) =>
          prev.channelId === targetChannelId ? { ...prev, hasMore: false } : prev,
        );
        isLoadingOlderRef.current = false;
        return;
      }
      if (selectedIdRef.current !== targetChannelId) {
        isLoadingOlderRef.current = false;
        return;
      }
      const hitWindowCap =
        messages.length + older.length >= MAX_LOADED_MESSAGES;
      const nextHasMore =
        !hitWindowCap &&
        Boolean(
          data.meta?.has_more_before ??
            data.meta?.has_more ??
            older.length >= OLDER_MESSAGE_PAGE_SIZE,
        );
      setWindowState((prev) => {
        if (prev.channelId !== targetChannelId) return prev;
        return {
          ...prev,
          hasMore: nextHasMore,
          store: trimMessageStoreToRecent(
            messagesToStore([...older, ...storeToMessages(prev.store)]),
            MAX_LOADED_MESSAGES,
          ),
        };
      });
      requestAnimationFrame(() => {
        if (container) {
          const heightDelta = container.scrollHeight - prevScrollHeight;
          if (heightDelta) {
            container.scrollBy(0, heightDelta);
          }
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
        setWindowState((prev) =>
          prev.channelId === targetChannelId ? { ...prev, hasMoreAfter: false } : prev,
        );
        return;
      }
      if (selectedIdRef.current !== targetChannelId) return;
      const nextHasMoreAfter = Boolean(
        data.meta?.has_more_after ??
          data.meta?.has_more ??
          newer.length >= OLDER_MESSAGE_PAGE_SIZE,
      );
      setWindowState((prev) => {
        if (prev.channelId !== targetChannelId) return prev;
        return {
          ...prev,
          hasMoreAfter: nextHasMoreAfter,
          store: trimMessageStoreToRecent(
            messagesToStore([...storeToMessages(prev.store), ...newer]),
            MAX_LOADED_MESSAGES,
          ),
        };
      });
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

      if (restoringInitialScrollRef.current || suppressInitialScrollEventsRef.current) {
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

    },
    [setJumpToBottomVisible],
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

  useEffect(() => {
    latestTopicRootsRef.current = topicRoots;
    latestVirtualItemsRef.current = virtualItems;
  }, [topicRoots, virtualItems]);

  useEffect(() => {
    if (
      loading ||
      restoringInitialScrollRef.current ||
      suppressInitialScrollEventsRef.current ||
      topicRoots.length === 0 ||
      virtualItems.length === 0
    ) {
      return;
    }
    const firstIndex = virtualItems[0]?.index ?? 0;
    const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? 0;
    const container = messagesContainerRef.current;
    if (!container) return;
    const bottomGap = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (
      firstIndex <= 2 &&
      container.scrollTop <= PAGINATION_EDGE_PX &&
      hasMore &&
      !loadingMore
    ) {
      loadMoreMessages();
      return;
    }
    if (
      lastIndex >= topicRoots.length - 3 &&
      bottomGap <= PAGINATION_EDGE_PX &&
      hasMoreNewer &&
      !loadingNewer
    ) {
      loadNewerMessages();
    }
  }, [
    hasMore,
    hasMoreNewer,
    loadMoreMessages,
    loadNewerMessages,
    loading,
    loadingMore,
    loadingNewer,
    topicRoots.length,
    virtualItems,
  ]);

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
      suppressInitialScrollEventsRef.current = false;
      lastScrollTopRef.current = container.scrollTop;
      setRestoringInitialScroll(false);
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
        settleMessageAnchor(
          container,
          initialTarget,
          finishInitialPlacement,
          initialTarget.align === "center"
            ? EXPLICIT_SCROLL_SETTLE_FRAMES
            : INITIAL_SCROLL_SETTLE_FRAMES,
        );
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
    }
  }, [
    messages,
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
    ensureMessageLoaded,
  };
}
