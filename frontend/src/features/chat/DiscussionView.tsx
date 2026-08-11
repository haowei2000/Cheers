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
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import type { Message } from "@/types";
import { MessageItem, type MessageActionHandlers } from "./MessageItem";

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

function titleAndPreview(message: Message) {
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
  return {
    title: (first ?? "Untitled discussion").slice(0, 120),
    preview: (rest.join(" ") || content).slice(0, 240),
  };
}

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
              className="bg-zinc-900/70 pl-9 pr-3 placeholder:text-zinc-500"
            />
          </label>
          <UiButton variant="plain"
            type="button"
            onClick={startDiscussion}
            controlSize="regular"
            className="shrink-0 bg-indigo-500 text-white hover:bg-indigo-400 focus-visible:ring-indigo-400"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New discussion</span>
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
            <MessageCircle className="h-8 w-8 text-zinc-600" />
            <div><p className="text-sm font-medium text-zinc-200">No discussions yet</p><p className="mt-1 text-xs text-zinc-500">Start a topic for the channel.</p></div>
            <UiButton variant="plain" type="button" onClick={startDiscussion} className="text-sm font-medium text-indigo-300 hover:text-indigo-200">Start the first discussion</UiButton>
          </div>
        ) : (
          <div className="space-y-2">
            {topics.map((topic) => {
              const copy = titleAndPreview(topic.root);
              const selected = selectedId === topic.root.msg_id && !creating;
              return (
                <UiButton variant="plain"
                  key={topic.root.msg_id}
                  type="button"
                  onClick={() => selectDiscussion(topic.root.msg_id)}
                  className={cn(
                    "group w-full rounded-sm border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60",
                    selected
                      ? "border-indigo-500/50 bg-indigo-500/10"
                      : "border-zinc-800 bg-zinc-900/45 hover:border-zinc-700 hover:bg-zinc-900/80",
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <Avatar name={topic.root.sender_name ?? "Unknown"} id={topic.root.sender_id} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{copy.title}</h3>
                        <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">{relativeActivity(topic.last_activity_at)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-400">{copy.preview}</p>
                      {topic.last_reply && (
                        <p className="mt-2 truncate text-[11px] text-zinc-500">
                          <span className="font-medium text-zinc-400">{topic.last_reply.sender_name}</span>
                          <span className="mx-1">·</span>{topic.last_reply.content || "Attachment"}
                        </p>
                      )}
                      <div className="mt-2.5 flex items-center gap-3 text-[11px] text-zinc-500">
                        <span className="inline-flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" />{topic.reply_count}</span>
                        <span className="inline-flex min-w-0 items-center gap-1"><Users className="h-3.5 w-3.5" />{topic.participant_count}</span>
                        <div className="flex -space-x-1.5">
                          {topic.participants.map((participant) => (
                            <Avatar key={`${participant.member_type}:${participant.member_id}`} name={participant.name} src={participant.avatar_url ?? undefined} id={participant.member_id} size="xs" className="ring-2 ring-zinc-900" />
                          ))}
                        </div>
                        <ChevronRight className="ml-auto h-4 w-4 text-zinc-600 transition-transform group-hover:translate-x-0.5" />
                      </div>
                    </div>
                  </div>
                </UiButton>
              );
            })}
            {nextCursor && (
              <UiButton variant="plain" controlSize="regular" type="button" disabled={loadingMore} onClick={() => void loadMoreTopics()} className="w-full text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Load more
              </UiButton>
            )}
          </div>
        )}
      </div>
    </section>
  );

  const detailPane = (
    <section className="flex min-h-0 flex-[1.5] flex-col bg-zinc-950">
      {(selectedId || creating) && !isWide && (
        <UiButton variant="plain" controlSize="comfortable" type="button" onClick={backToTopics} className="w-full justify-start border-b border-zinc-800 text-zinc-300 hover:bg-zinc-900 focus-visible:ring-inset">
          <ArrowLeft className="h-4 w-4" />Discussions
        </UiButton>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
      {creating ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-sm"><MessageCircle className="mx-auto h-10 w-10 text-indigo-400" /><h2 className="mt-4 text-lg font-semibold text-zinc-100">Start a new discussion</h2><p className="mt-2 text-sm leading-6 text-zinc-400">Write the topic in the composer below. The first non-empty line becomes its title.</p></div>
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
                <Avatar name={detail.root.sender_name ?? senderNames?.get(detail.root.sender_id) ?? "Unknown"} id={detail.root.sender_id} size="sm" />
                <div className="min-w-0 flex-1">
                  <h2 className="line-clamp-2 text-base font-semibold leading-6 text-zinc-100">{titleAndPreview(detail.root).title}</h2>
                  <p className="mt-0.5 text-xs text-zinc-500">{detail.root.sender_name ?? senderNames?.get(detail.root.sender_id) ?? "Unknown"} · {formatTime(detail.root.created_at)}</p>
                  <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-400">{titleAndPreview(detail.root).preview}</p>
                </div>
              </div>
            </div>
          </header>
          <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto py-3">
            <div className="mx-auto flex max-w-[56rem] flex-col gap-2 px-2 md:px-4">
              {detail.meta.has_more_before && (
                <UiButton variant="plain" controlSize="regular" type="button" disabled={loadingOlder} onClick={() => void loadOlderReplies()} className="mx-auto text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">
                  {loadingOlder && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Load older replies
                </UiButton>
              )}
              {detail.replies.length === 0 ? (
                <div className="py-16 text-center text-sm text-zinc-500">No replies yet. Continue the discussion below.</div>
              ) : detail.replies.map((message) => (
                <div key={message.msg_id} data-msg-id={message.msg_id}>
                  <MessageItem
                    message={message}
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
        <div className="flex flex-1 items-center justify-center px-6 text-center"><div><MessageCircle className="mx-auto h-9 w-9 text-zinc-700" /><p className="mt-3 text-sm font-medium text-zinc-300">Select a discussion</p><p className="mt-1 text-xs text-zinc-500">Open a topic to read and reply.</p></div></div>
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
