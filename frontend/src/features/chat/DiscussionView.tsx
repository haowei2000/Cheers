/** @file Discussion-mode channel UI for browsing topics and their reply threads. */

import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  Loader2,
  MessageCircle,
  Plus,
  Search,
  Users,
} from "lucide-react";
import {
  getDiscussion,
  listDiscussions,
  type DiscussionDetailResponse,
  type DiscussionSummary,
} from "@/api/discussions";
import { Avatar } from "@/components/ui/avatar";
import { ErrorState } from "@/components/ui/error-state";
import { ItemList, ItemRow } from "@/components/ui/item";
import { controlIconClasses, controlTextClasses } from "@/components/ui/control-size";
import { cn } from "@/lib/cn";
import type { Message } from "@/types";
import { MessageItem, type MessageActionHandlers } from "./MessageItem";
import { isDiscussionConsecutive } from "./messageTree";

interface Props {
  channelId: string;
  currentUserId?: string;
  senderNames?: Map<string, string>;
  actions?: MessageActionHandlers;
  replyToId?: string | null;
  realtimeVersion: number;
  openDiscussionId?: string | null;
  footer?: ReactNode;
  onComposerContextChange: (root: Message | null, creating: boolean) => void;
}

/** Derive a short topic title and preview from a root message's plain text. */
export function titleAndPreview(message: Message) {
  const content = (message.content ?? "").trim();
  if (message.is_deleted) {
    return { title: "Deleted discussion", preview: "The original post was deleted." };
  }
  if (!content) {
    return {
      title: message.files?.length ? "Shared attachment" : "Untitled discussion",
      preview: message.files?.length ? `${message.files.length} attachment${message.files.length === 1 ? "" : "s"}` : "",
    };
  }
  const [first, ...rest] = content.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const preview = rest.join(" ").slice(0, 240);
  return {
    title: (first ?? "Untitled discussion").slice(0, 120),
    // The first non-empty line is the title. Repeat only subsequent body copy.
    preview,
  };
}

/** Format a server timestamp as a compact relative-activity label. */
function relativeActivity(value: string) {
  const time = new Date(value).getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Render a searchable, paginated topic list with an inline thread reader. */
export function DiscussionView({
  channelId,
  currentUserId,
  senderNames,
  actions,
  replyToId,
  realtimeVersion,
  openDiscussionId,
  footer,
  onComposerContextChange,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("discussion");
  const [isWide, setIsWide] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [topics, setTopics] = useState<DiscussionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingTopics, setLoadingTopics] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [topicError, setTopicError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DiscussionDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const storageKey = `cheers:last-discussion:${channelId}`;
  const onComposerContextChangeRef = useRef(onComposerContextChange);

  useEffect(() => {
    onComposerContextChangeRef.current = onComposerContextChange;
  }, [onComposerContextChange]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setIsWide((entry?.contentRect.width ?? 0) >= 900);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const refreshTopics = useCallback(async () => {
    try {
      setTopicError(null);
      const response = await listDiscussions(channelId, {
        limit: 30,
        q: debouncedQuery || undefined,
      });
      setTopics(response.discussions);
      setNextCursor(response.meta.next_cursor ?? null);
    } catch (error) {
      setTopicError(error instanceof Error ? error.message : "Couldn't load discussions");
    } finally {
      setLoadingTopics(false);
    }
  }, [channelId, debouncedQuery]);

  useEffect(() => {
    setLoadingTopics(true);
    void refreshTopics();
  }, [refreshTopics]);

  useEffect(() => {
    if (realtimeVersion === 0) return;
    const timer = window.setTimeout(() => void refreshTopics(), 250);
    return () => window.clearTimeout(timer);
  }, [realtimeVersion, refreshTopics]);

  const selectDiscussion = useCallback(
    (id: string, replace = false) => {
      setCreating(false);
      const next = new URLSearchParams(searchParams);
      next.set("discussion", id);
      setSearchParams(next, { replace });
      window.localStorage.setItem(storageKey, id);
    },
    [searchParams, setSearchParams, storageKey],
  );

  useEffect(() => {
    if (!openDiscussionId) return;
    selectDiscussion(openDiscussionId);
  }, [openDiscussionId, selectDiscussion]);

  useEffect(() => {
    if (!isWide || selectedId || creating || topics.length === 0 || debouncedQuery) return;
    const stored = window.localStorage.getItem(storageKey);
    const candidate = topics.find((topic) => topic.root.msg_id === stored)?.root.msg_id
      ?? topics[0]?.root.msg_id;
    if (candidate) selectDiscussion(candidate, true);
  }, [creating, debouncedQuery, isWide, selectDiscussion, selectedId, storageKey, topics]);

  const refreshDetail = useCallback(async (showSpinner = true) => {
    if (!selectedId) {
      setDetail(null);
      onComposerContextChangeRef.current(null, creating);
      return;
    }
    if (showSpinner) setLoadingDetail(true);
    try {
      setDetailError(null);
      const response = await getDiscussion(channelId, selectedId, { limit: 50 });
      setDetail(response);
      onComposerContextChangeRef.current(response.root, false);
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : "Couldn't load this discussion");
      onComposerContextChangeRef.current(null, false);
    } finally {
      setLoadingDetail(false);
    }
  }, [channelId, creating, selectedId]);

  useEffect(() => {
    void refreshDetail();
  }, [refreshDetail]);

  useEffect(() => {
    if (!selectedId || realtimeVersion === 0) return;
    const timer = window.setTimeout(() => void refreshDetail(false), 250);
    return () => window.clearTimeout(timer);
  }, [realtimeVersion, refreshDetail, selectedId]);

  useEffect(() => {
    if (!replyToId) return;
    rootRef.current
      ?.querySelector(`[data-msg-id="${CSS.escape(replyToId)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [replyToId]);

  const startDiscussion = () => {
    setCreating(true);
    setDetail(null);
    const next = new URLSearchParams(searchParams);
    next.delete("discussion");
    setSearchParams(next);
    onComposerContextChange(null, true);
  };

  const backToTopics = () => {
    setCreating(false);
    setDetail(null);
    const next = new URLSearchParams(searchParams);
    next.delete("discussion");
    setSearchParams(next);
    onComposerContextChange(null, false);
  };

  const loadMoreTopics = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await listDiscussions(channelId, {
        cursor: nextCursor,
        limit: 30,
        q: debouncedQuery || undefined,
      });
      setTopics((current) => [...current, ...response.discussions]);
      setNextCursor(response.meta.next_cursor ?? null);
    } finally {
      setLoadingMore(false);
    }
  };

  const loadOlderReplies = async () => {
    const first = detail?.replies[0];
    if (!selectedId || !first || !detail.meta.has_more_before || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const response = await getDiscussion(channelId, selectedId, {
        before: first.msg_id,
        limit: 50,
      });
      setDetail((current) => current ? {
        ...current,
        replies: [...response.replies, ...current.replies],
        meta: response.meta,
      } : response);
    } finally {
      setLoadingOlder(false);
    }
  };

  const topicList = (
    <section className="flex min-h-0 flex-1 flex-col border-zinc-800 bg-zinc-950/40 md:border-r">
      <div className="border-b border-zinc-800/80 p-3">
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <span className="sr-only">Search discussions</span>
            <UiInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search discussions"
              inset="leading"
              className="bg-zinc-900/70 placeholder:text-zinc-500"
            />
          </label>
          <UiButton content="iconText" action="create" variant="plain"
            type="button"
            onClick={startDiscussion}
            aria-label="Create a new discussion"
            controlSize="regular"
            className="shrink-0 bg-indigo-500 text-white hover:bg-indigo-400 focus-visible:ring-indigo-400"
          >
            <Plus className="h-4 w-4" />
          </UiButton>
        </div>
      </div>
      <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
        {loadingTopics && topics.length === 0 ? (
          <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-zinc-500" /></div>
        ) : topicError && topics.length === 0 ? (
          <ErrorState title="Couldn't load discussions" description={topicError} action={{ label: "Retry", onClick: refreshTopics }} />
        ) : topics.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <MessageCircle className="h-5 w-5 text-zinc-600" />
            <div><p className="text-regular font-medium text-zinc-200">No discussions yet</p><p className="mt-1 text-compact text-zinc-500">Start a topic for the channel.</p></div>
            <UiButton action="start" variant="plain" type="button" onClick={startDiscussion} className="font-medium text-indigo-300 hover:text-indigo-200">Start the first discussion</UiButton>
          </div>
        ) : (
          <ItemList presentationLevel="medium" controlSize="regular" className="space-y-2">
            {topics.map((topic) => {
              const copy = titleAndPreview(topic.root);
              const selected = selectedId === topic.root.msg_id && !creating;
              return (
                <ItemRow
                  key={topic.root.msg_id}
                  kind="conversation"
                  presentationLevel="medium"
                  controlSize="regular"
                  onClick={() => selectDiscussion(topic.root.msg_id)}
                  selected={selected}
                  leading={<Avatar name={topic.root.sender_name ?? "Unknown"} id={topic.root.sender_id} size="regular" />}
                  title={<span title={[
                    copy.title,
                    copy.preview,
                    topic.last_reply ? `${topic.last_reply.sender_name}: ${topic.last_reply.content || "Attachment"}` : null,
                  ].filter(Boolean).join(" · ")}>
                    {copy.title}{copy.preview ? ` — ${copy.preview}` : ""}
                  </span>}
                  status={(
                    <span className={cn("inline-flex shrink-0 items-center gap-2 text-zinc-500", controlTextClasses.compact)}>
                      <span className="inline-flex items-center gap-1"><MessageCircle className={controlIconClasses.compact} />{topic.reply_count}</span>
                      <span className="inline-flex items-center gap-1"><Users className={controlIconClasses.compact} />{topic.participant_count}</span>
                    </span>
                  )}
                  trailing={(
                    <span className={cn("inline-flex items-center gap-1 tabular-nums text-zinc-500", controlTextClasses.compact)}>
                      {relativeActivity(topic.last_activity_at)}
                      <ChevronRight className={cn(controlIconClasses.regular, "text-zinc-600 transition-transform group-hover/item:translate-x-0.5")} />
                    </span>
                  )}
                  className={cn(
 "border-b-0 ",
 !selected && "bg-zinc-900/45 hover:bg-zinc-900/80",
 )}
                />
              );
            })}
            {nextCursor && (
              <UiButton action="more" controlWidth="fill" variant="plain" controlSize="regular" type="button" disabled={loadingMore} onClick={() => void loadMoreTopics()} className=" text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Load more
              </UiButton>
            )}
          </ItemList>
        )}
      </div>
    </section>
  );

  const detailPane = (
    <section className="flex min-h-0 flex-[1.5] flex-col bg-zinc-950">
      {(selectedId || creating) && !isWide && (
        <UiButton action="start" content="iconText" controlWidth="fill" variant="plain" controlSize="comfortable" type="button" onClick={backToTopics} className="justify-start border-b border-zinc-800 text-zinc-300 hover:bg-zinc-900 focus-visible:ring-inset">
          <ArrowLeft className="h-4 w-4" />Discussions
        </UiButton>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
      {creating ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-sm"><MessageCircle className="mx-auto h-5 w-5 text-indigo-400" /><h2 className="mt-4 text-comfortable font-semibold text-zinc-100">Start a new discussion</h2><p className="mt-2 text-regular leading-6 text-zinc-400">Write the topic in the composer below. The first non-empty line becomes its title.</p></div>
        </div>
      ) : loadingDetail ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-zinc-500" /></div>
      ) : detailError ? (
        <ErrorState className="flex-1" title="Couldn't open discussion" description={detailError} action={{ label: "Retry", onClick: () => void refreshDetail() }} />
      ) : detail ? (
        <>
          <header className="z-10 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
            <div className="mx-auto max-w-[52rem]">
              <div className="flex items-start gap-3">
                <Avatar name={detail.root.sender_name ?? senderNames?.get(detail.root.sender_id) ?? "Unknown"} id={detail.root.sender_id} size="regular" />
                <div className="min-w-0 flex-1">
                  <h2 className="line-clamp-2 font-display text-comfortable font-semibold leading-6 tracking-[-0.015em] text-zinc-100">{titleAndPreview(detail.root).title}</h2>
                  <p className="mt-1 font-utility text-compact text-zinc-500">{detail.root.sender_name ?? senderNames?.get(detail.root.sender_id) ?? "Unknown"}</p>
                  {titleAndPreview(detail.root).preview && (
                    <p className="mt-2 line-clamp-3 font-reading text-regular font-normal leading-6 text-zinc-400">{titleAndPreview(detail.root).preview}</p>
                  )}
                </div>
              </div>
            </div>
          </header>
          <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto py-3">
            <div className="mx-auto flex max-w-[56rem] flex-col gap-1 px-2 md:px-4">
              {detail.meta.has_more_before && (
                <UiButton action="more" variant="plain" controlSize="regular" type="button" disabled={loadingOlder} onClick={() => void loadOlderReplies()} className="mx-auto  text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">
                  {loadingOlder && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Load older replies
                </UiButton>
              )}
              {detail.replies.length === 0 ? (
                <div className="py-16 text-center text-regular text-zinc-500">No replies yet. Continue the discussion below.</div>
              ) : detail.replies.map((message, index) => (
                <div key={message.msg_id} data-msg-id={message.msg_id}>
                  <MessageItem
                    message={message}
                    isConsecutive={index > 0 && isDiscussionConsecutive(detail.replies[index - 1], message)}
                    alignOwnMessages={false}
                    hideReplyQuote
                    currentUserId={currentUserId}
                    channelId={channelId}
                    senderName={senderNames?.get(message.sender_id)}
                    actions={actions}
                  />
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center"><div><MessageCircle className="mx-auto h-5 w-5 text-zinc-600" /><p className="mt-3 text-regular font-medium text-zinc-300">Select a discussion</p><p className="mt-1 text-compact text-zinc-500">Open a topic to read and reply.</p></div></div>
      )}
      </div>
      {(selectedId || creating) && footer}
    </section>
  );

  const showDetailOnNarrow = Boolean(selectedId || creating);
  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 overflow-hidden">
      {isWide ? <>{topicList}{detailPane}</> : showDetailOnNarrow ? detailPane : topicList}
    </div>
  );
}
