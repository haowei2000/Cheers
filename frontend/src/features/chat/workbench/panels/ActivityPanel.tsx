// Activity — the channel's HISTORY FEED (Claude/Codex session-review style):
// a chronological, day-grouped timeline of everything that happened, newest
// first. Each row is one event with the actor's avatar, a one-line excerpt and
// badges for what kind of interaction it was (@mentions, reply, files, message
// type); operation events (workspace writes, member changes) render as compact
// system rows. Clicking a message row jumps the chat to that message
// (ctx.onJumpToMessage — best-effort: scroll + flash when loaded, toast hint
// otherwise). Sourced from `channel.activity.read` (messages ∪ operations) +
// REST listChannelMembers (id -> name + avatar_url). The multi-select member
// filter narrows the feed to events that touch ANY selected member. All
// ids/names/content are agent-authored and render as inert text.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AtSign,
  Cog,
  CornerUpLeft,
  Filter,
  Paperclip,
  Search,
  Check,
  ChevronDown,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDayLabel, sameDay } from "@/lib/format";
import { listChannelMembers } from "@/api/channels";
import type { MemberItem } from "@/types";
import { Avatar } from "@/components/ui/avatar";
import {
  registerComponentViewBoard,
  useBoardTickRefetch,
  ViewBoardShell,
  type ViewBoardContext,
} from "../viewBoard";

interface Mention {
  member_id: string;
  member_type: "user" | "bot";
}

interface MessageData {
  msg_id?: string;
  sender_type?: "user" | "bot";
  sender_id?: string;
  content?: string;
  msg_type?: string;
  mentions?: Mention[];
  file_ids?: string[];
  reply_to_msg_id?: string | null;
  created_at?: string;
}

interface OperationData {
  op_type?: string;
  actor_type?: "user" | "bot" | "system";
  actor_id?: string | null;
  target_ref?: string | null;
  created_at?: string;
}

interface ActivityEvent {
  event_type: "message" | "operation";
  channel_seq: number;
  created_at?: string | null;
  data: MessageData & OperationData;
}

function short(id?: string | null): string {
  return typeof id === "string" && id ? id.slice(0, 8) : "";
}

function fmtTime(ts?: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** One readable line of a message: file tags stripped, whitespace collapsed. */
function excerpt(content?: string): string {
  if (!content) return "";
  const t = content.replace(/<#file:[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return t.length > 140 ? `${t.slice(0, 140)}…` : t;
}

const humanize = (id: string) => id.replaceAll("_", " ").replaceAll(".", " · ");

type MemberLookup = (id?: string | null) => MemberItem | undefined;

function nameOf(member: MemberItem | undefined, id?: string | null): string {
  return member?.display_name || member?.username || short(id) || "unknown";
}

/** Tiny inline badge (mention target / reply / files / msg type). */
function Badge({
  className,
  children,
  title,
}: {
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] leading-4 whitespace-nowrap",
        className
      )}
    >
      {children}
    </span>
  );
}

function MessageRow({
  e,
  memberOf,
  onJump,
}: {
  e: ActivityEvent;
  memberOf: MemberLookup;
  onJump?: (msgId: string) => void;
}) {
  const d = e.data;
  const sender = memberOf(d.sender_id);
  const name = nameOf(sender, d.sender_id);
  const line = excerpt(d.content);
  const files = d.file_ids?.length ?? 0;
  const mentions = d.mentions ?? [];
  const clickable = Boolean(d.msg_id && onJump);
  // Only badge NOTEWORTHY message types — "text" and "normal" are both just
  // plain messages (users send "text", bots send "normal").
  const specialType =
    d.msg_type && d.msg_type !== "text" && d.msg_type !== "normal" ? d.msg_type : null;

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => d.msg_id && onJump?.(d.msg_id)}
      title={clickable ? "Jump to this message" : undefined}
      className={cn(
        "w-full text-left px-3 py-1.5 flex items-start gap-2 rounded-md transition-colors",
        clickable && "hover:bg-zinc-800/50 cursor-pointer"
      )}
    >
      <Avatar
        name={name}
        src={sender?.avatar_url ?? undefined}
        id={d.sender_id}
        size="xs"
        className="mt-0.5 !w-5 !h-5 !text-[9px]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium text-zinc-300 truncate">{name}</span>
          {d.sender_type === "bot" && (
            <span className="text-[9px] uppercase tracking-wide text-violet-400/70 flex-shrink-0">
              bot
            </span>
          )}
          <div className="flex-1" />
          <span className="text-[10px] text-zinc-600 tabular-nums whitespace-nowrap">
            {fmtTime(d.created_at ?? e.created_at)}
          </span>
        </div>
        {line && (
          <div className="text-[11px] text-zinc-500 truncate mt-px">{line}</div>
        )}
        {(mentions.length > 0 || d.reply_to_msg_id || files > 0 || specialType) && (
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {d.reply_to_msg_id && (
              <Badge className="bg-emerald-500/10 text-emerald-300/90" title="Reply">
                <CornerUpLeft className="w-2.5 h-2.5" />
                reply
              </Badge>
            )}
            {mentions.map((m) => (
              <Badge
                key={m.member_id}
                className="bg-indigo-500/10 text-indigo-300/90"
                title={`@${nameOf(memberOf(m.member_id), m.member_id)}`}
              >
                <AtSign className="w-2.5 h-2.5" />
                {nameOf(memberOf(m.member_id), m.member_id)}
              </Badge>
            ))}
            {files > 0 && (
              <Badge className="bg-zinc-700/40 text-zinc-400" title={`${files} file(s)`}>
                <Paperclip className="w-2.5 h-2.5" />
                {files}
              </Badge>
            )}
            {specialType && (
              <Badge className="bg-amber-500/10 text-amber-300/90">{specialType}</Badge>
            )}
          </div>
        )}
      </div>
    </button>
  );
}

/** Operation events (workspace writes, member changes…) — compact system rows;
 *  no msg_id, so not clickable. */
function OperationRow({ e, memberOf }: { e: ActivityEvent; memberOf: MemberLookup }) {
  const d = e.data;
  const actor = memberOf(d.actor_id);
  const name = d.actor_id ? nameOf(actor, d.actor_id) : "system";
  return (
    <div className="px-3 py-1 flex items-center gap-2">
      {d.actor_id ? (
        <Avatar
          name={name}
          src={actor?.avatar_url ?? undefined}
          id={d.actor_id}
          size="xs"
          className="!w-4 !h-4 !text-[8px]"
        />
      ) : (
        <span className="w-4 h-4 rounded-full bg-zinc-800 flex items-center justify-center flex-shrink-0">
          <Cog className="w-2.5 h-2.5 text-zinc-500" />
        </span>
      )}
      <span className="min-w-0 flex-1 text-[10px] text-zinc-500 truncate">
        <span className="text-zinc-400">{name}</span> · {humanize(d.op_type ?? "operation")}
        {d.target_ref && <span className="font-mono text-zinc-600"> · {d.target_ref}</span>}
      </span>
      <span className="text-[10px] text-zinc-600 tabular-nums whitespace-nowrap">
        {fmtTime(d.created_at ?? e.created_at)}
      </span>
    </div>
  );
}

function ActivityBody({ ctx }: { ctx: ViewBoardContext }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(false);
  // Multi-select member filter: the set of member_ids whose events to show.
  // Empty = show everyone.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggleMember = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const load = useCallback(async () => {
    setLoading(true);
    const [activityRes, membersRes] = await Promise.allSettled([
      ctx.sendResourceReq("channel.activity.read", {
        channel_id: ctx.channelId,
        limit: 200,
        desc: true,
      }),
      listChannelMembers(ctx.channelId),
    ]);
    setEvents(
      activityRes.status === "fulfilled"
        ? ((activityRes.value as { events?: ActivityEvent[] })?.events ?? [])
        : []
    );
    if (membersRes.status === "fulfilled") setMembers(membersRes.value ?? []);
    setLoading(false);
  }, [ctx.channelId, ctx.sendResourceReq]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-push: ChannelView bumps the "activity" tick on every new message.
  // Deferred while the board is kept-alive but hidden; catches up on reveal.
  useBoardTickRefetch(ctx, "activity", load);

  const byId = useMemo(() => {
    const m = new Map<string, MemberItem>();
    for (const mem of members) m.set(mem.member_id, mem);
    return m;
  }, [members]);
  const memberOf: MemberLookup = useCallback((id) => (id ? byId.get(id) : undefined), [byId]);

  // The member filter keeps events that TOUCH any selected member: as sender /
  // operation actor, as an @mention target, or (for replies) implicitly via the
  // sender side — reply targets aren't resolvable without the replied message.
  const shownEvents = useMemo(() => {
    const all = events ?? [];
    if (!selected.size) return all;
    return all.filter((e) => {
      const d = e.data;
      if (d.sender_id && selected.has(d.sender_id)) return true;
      if (d.actor_id && selected.has(d.actor_id)) return true;
      return (d.mentions ?? []).some((m) => selected.has(m.member_id));
    });
  }, [events, selected]);

  return (
    <ViewBoardShell title="Activity" icon={Activity} loading={loading} onRefresh={() => void load()}>
      {members.length > 0 && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-zinc-900">
          <MemberFilter
            members={members}
            memberOf={memberOf}
            selected={selected}
            onToggle={toggleMember}
            onClear={clearSelection}
          />
          {selected.size > 0 && (
            <div className="flex items-center gap-1 overflow-x-auto">
              {members
                .filter((mem) => selected.has(mem.member_id))
                .map((mem) => (
                  <FilterChip key={mem.member_id} active onClick={() => toggleMember(mem.member_id)}>
                    <Avatar
                      name={nameOf(mem, mem.member_id)}
                      src={mem.avatar_url ?? undefined}
                      id={mem.member_id}
                      size="xs"
                      className="!w-3.5 !h-3.5 !text-[7px]"
                    />
                    <span className="truncate max-w-[80px]">{nameOf(mem, mem.member_id)}</span>
                    <X className="w-2.5 h-2.5 opacity-60" />
                  </FilterChip>
                ))}
              <button
                onClick={clearSelection}
                className="flex-shrink-0 px-1.5 text-[10px] text-zinc-500 hover:text-zinc-300"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {events == null ? (
        <div className="px-3 py-6 text-xs text-zinc-600">Loading…</div>
      ) : shownEvents.length === 0 ? (
        <div className="px-3 py-10 text-center text-xs text-zinc-600">
          No activity yet — messages and operations will appear here.
        </div>
      ) : (
        <div className="py-1.5">
          {shownEvents.map((e, i) => {
            const prev = shownEvents[i - 1];
            const ts = e.data.created_at ?? e.created_at ?? undefined;
            const prevTs = prev ? prev.data.created_at ?? prev.created_at ?? undefined : undefined;
            // Newest-first feed: a day label opens each new (older) day group.
            const showDay = !prev || !sameDay(ts, prevTs);
            return (
              <div key={`${e.event_type}-${e.channel_seq}`}>
                {showDay && ts && (
                  <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                    <span className="text-[10px] font-medium text-zinc-500">
                      {formatDayLabel(ts)}
                    </span>
                    <div className="flex-1 h-px bg-zinc-800/70" />
                  </div>
                )}
                {e.event_type === "message" ? (
                  <MessageRow e={e} memberOf={memberOf} onJump={ctx.onJumpToMessage} />
                ) : (
                  <OperationRow e={e} memberOf={memberOf} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </ViewBoardShell>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] whitespace-nowrap flex-shrink-0 border transition-colors ${
        active
          ? "border-zinc-600 bg-zinc-800 text-zinc-200"
          : "border-transparent bg-zinc-900/60 text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

/** Searchable multi-select of channel members ("Filter members" button opening a
 *  searchable checkbox list). Selection lives in the parent (a Set of member_ids);
 *  active picks also render as removable chips next to the button. Outside-click /
 *  Escape dismiss, same pattern as ComposerModelPopover. */
function MemberFilter({
  members,
  memberOf,
  selected,
  onToggle,
  onClear,
}: {
  members: MemberItem[];
  memberOf: MemberLookup;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-activity-filter-root]"))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ql = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      members.filter((m) => {
        if (!ql) return true;
        const name = (m.display_name || m.username || m.member_id).toLowerCase();
        return name.includes(ql);
      }),
    [members, ql]
  );

  return (
    <div className="relative flex-shrink-0" data-activity-filter-root>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Filter activity by member"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors",
          open || selected.size
            ? "border-indigo-500/50 bg-indigo-600/10 text-indigo-200"
            : "border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
        )}
      >
        <Filter className="w-3.5 h-3.5" />
        <span>{selected.size ? `${selected.size} selected` : "Filter members"}</span>
        <ChevronDown
          className={cn("w-3 h-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 w-60 max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl">
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-zinc-800">
            <Search className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search members…"
              className="flex-1 min-w-0 bg-transparent text-xs text-zinc-200 placeholder:text-zinc-600 outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {shown.length === 0 ? (
              <div className="px-3 py-3 text-center text-[11px] text-zinc-600">
                No members match.
              </div>
            ) : (
              shown.map((mem) => {
                const on = selected.has(mem.member_id);
                return (
                  <button
                    key={mem.member_id}
                    type="button"
                    onClick={() => onToggle(mem.member_id)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-zinc-800/70 transition-colors"
                  >
                    <span
                      className={cn(
                        "flex items-center justify-center w-3.5 h-3.5 rounded border flex-shrink-0",
                        on ? "border-indigo-400 bg-indigo-500/80" : "border-zinc-600"
                      )}
                    >
                      {on && <Check className="w-2.5 h-2.5 text-white" />}
                    </span>
                    <Avatar
                      name={nameOf(memberOf(mem.member_id), mem.member_id)}
                      src={mem.avatar_url ?? undefined}
                      id={mem.member_id}
                      size="xs"
                      className="!w-4 !h-4 !text-[8px]"
                    />
                    <span className="flex-1 truncate text-xs text-zinc-300">
                      {mem.display_name || mem.username || short(mem.member_id)}
                    </span>
                    {mem.member_type === "bot" && (
                      <span className="text-[9px] uppercase tracking-wide text-zinc-600 flex-shrink-0">
                        bot
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
          {selected.size > 0 && (
            <div className="border-t border-zinc-800 px-2 py-1.5">
              <button
                type="button"
                onClick={onClear}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Clear selection ({selected.size})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

registerComponentViewBoard({
  id: "activity",
  title: "Activity",
  icon: Activity,
  component: (ctx) => <ActivityBody ctx={ctx} />,
});
