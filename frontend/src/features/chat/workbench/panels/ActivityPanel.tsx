// Activity — the channel's collaboration history as a FLOW LIST. One row per
// episode (a causal unit: a human's @mention plus the bot turns / approvals /
// file writes that follow — see activityEpisodes.ts). The collapsed row is a
// single line: a relay chain of avatars (trigger human → the bots involved),
// the trigger excerpt, and the time — so scanning the column reads as "who
// asked which bots to do what, when". Exactly one episode expands inline
// (indigo-tinted block): a muted outcome summary plus the message rows hung on
// a left rule; hovering a message row reveals a jump arrow that scrolls the
// chat to the original message (ctx.onJumpToMessage). Three lenses: Flow
// (newest auto-expanded), Highlights (only episodes with a decision/artifact),
// All (every episode expanded). Sourced from `channel.activity.read`
// (messages ∪ operations) + REST listChannelMembers. All content is inert text.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Filter,
  Paperclip,
  Pencil,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { listChannelMembers } from "@/api/channels";
import type { MemberItem } from "@/types";
import { Avatar } from "@/components/ui/avatar";
import { agentIconFor } from "@/components/ui/agentIcons";
import {
  registerComponentViewBoard,
  useBoardTickRefetch,
  ViewBoardShell,
  type ViewBoardContext,
} from "../viewBoard";
import {
  buildEpisodes,
  isNotableEpisode,
  type ActivityEvent,
  type Episode,
  type NormEvent,
} from "./activityEpisodes";

function short(id?: string | null): string {
  return typeof id === "string" && id ? id.slice(0, 8) : "";
}

function fmtTime(ts?: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Span between two ISO stamps at a readable unit: "8 min" / "3 h" / "6 d"
 *  ("" if <1min). Long-running episodes (a bot thread spanning days) would
 *  otherwise read as "8213 min". */
function fmtSpan(a?: string | null, b?: string | null): string {
  if (!a || !b) return "";
  const t0 = Date.parse(a);
  const t1 = Date.parse(b);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return "";
  const min = Math.round(Math.abs(t1 - t0) / 60000);
  if (min < 1) return "";
  if (min < 120) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

type MemberLookup = (id?: string | null) => MemberItem | undefined;

function nameOf(member: MemberItem | undefined, id?: string | null): string {
  return member?.display_name || member?.username || short(id) || "unknown";
}

type Lens = "flow" | "highlights" | "all";

// ── episode helpers that need the member map (kept out of the pure module) ──
function episodeTitle(ep: Episode, memberOf: MemberLookup): string {
  if (ep.title) return ep.title;
  const dom = memberOf(ep.dominantActorId);
  return `${nameOf(dom, ep.dominantActorId)} activity`;
}

/** Outcome one-liner for the expanded header: "6 messages · 2 approvals · 10 writes · 12 min". */
function episodeSummary(ep: Episode): string {
  const p: string[] = [];
  if (ep.counts.messages) p.push(`${ep.counts.messages} message${ep.counts.messages > 1 ? "s" : ""}`);
  if (ep.counts.approvals) p.push(`${ep.counts.approvals} approval${ep.counts.approvals > 1 ? "s" : ""}`);
  if (ep.counts.writes) p.push(`${ep.counts.writes} write${ep.counts.writes > 1 ? "s" : ""}`);
  if (ep.counts.files) p.push(`${ep.counts.files} file${ep.counts.files > 1 ? "s" : ""}`);
  const span = fmtSpan(ep.startTs, ep.endTs);
  if (span) p.push(span);
  return p.join(" · ");
}

/** Does this episode touch ANY of the selected member ids (participant or @)? */
function episodeTouches(ep: Episode, selected: Set<string>): boolean {
  for (const id of ep.participants) if (selected.has(id)) return true;
  for (const n of ep.events) for (const m of n.mentions) if (selected.has(m.member_id)) return true;
  return false;
}

/** The bots in this episode's relay chain, in order of first appearance —
 *  mentioned-by-the-trigger first (intent), then whoever actually spoke/acted.
 *  Uses the events' own type tags so a bot that already left the channel
 *  (missing from the member map) still shows in the chain. */
function episodeBots(ep: Episode): string[] {
  const bots: string[] = [];
  const push = (id?: string | null) => {
    if (id && !bots.includes(id)) bots.push(id);
  };
  for (const n of ep.events) {
    if (n.kind === "trigger") {
      for (const m of n.mentions) if (m.member_type === "bot") push(m.member_id);
    } else if (n.actorType === "bot") {
      push(n.actorId);
    }
  }
  return bots;
}

// ── relay chain: trigger avatar → the bots involved ────────────────────────
const CHAIN_BOT_CAP = 3;

function ChainAvatars({ ep, memberOf }: { ep: Episode; memberOf: MemberLookup }) {
  const lead = ep.triggerActorId ?? ep.dominantActorId;
  const bots = episodeBots(ep).filter((id) => id !== lead);
  const shown = bots.slice(0, CHAIN_BOT_CAP);
  const leadMember = memberOf(lead);
  return (
    <span className="flex items-center flex-shrink-0">
      <Avatar
        name={nameOf(leadMember, lead)}
        src={leadMember?.avatar_url ?? undefined}
        id={lead ?? ep.id}
        size="xs"
        className="!w-4 !h-4"
      />
      {shown.length > 0 && <ArrowRight className="w-3 h-3 text-zinc-600 flex-shrink-0" />}
      {shown.map((id, i) => {
        const mem = memberOf(id);
        return (
          <Avatar
            key={id}
            name={nameOf(mem, id)}
            src={mem?.avatar_url ?? undefined}
            id={id}
            size="xs"
            className={cn("!w-4 !h-4", i > 0 && "-ml-1 ring-1 ring-zinc-900")}
          />
        );
      })}
      {bots.length > shown.length && (
        <span className="ml-0.5 text-[10px] text-zinc-400">+{bots.length - shown.length}</span>
      )}
    </span>
  );
}

// ── expanded detail: the episode's events hung on a left rule ───────────────
interface MutedItem {
  kind: "write" | "approval";
  actorId?: string | null;
  count: number;
}
type DetailRow =
  | { type: "event"; n: NormEvent }
  | { type: "muted"; items: MutedItem[]; seq: number };

/** Fold consecutive non-message events (writes/ops + approvals) into ONE muted
 *  summary row — "claude wrote 10 files · haowei approved ×2" — and keep
 *  messages individually rendered (each stays jump-to-able). Chronological —
 *  the flow reads top-down like the conversation it summarizes. */
function detailRows(ep: Episode): DetailRow[] {
  const rows: DetailRow[] = [];
  for (const n of ep.events) {
    if (n.kind === "write" || n.kind === "op" || n.kind === "approval") {
      const kind: MutedItem["kind"] = n.kind === "approval" ? "approval" : "write";
      const last = rows[rows.length - 1];
      if (last && last.type === "muted") {
        const item = last.items.find((it) => it.kind === kind && it.actorId === n.actorId);
        if (item) item.count += 1;
        else last.items.push({ kind, actorId: n.actorId, count: 1 });
        last.seq = n.seq;
      } else {
        rows.push({ type: "muted", items: [{ kind, actorId: n.actorId, count: 1 }], seq: n.seq });
      }
    } else {
      rows.push({ type: "event", n });
    }
  }
  return rows;
}

/** Bot senders read by brand color (claude clay, codex green, …) so a
 *  multi-bot thread scans by name color without repeating avatars per row.
 *  Lightened toward white so the darker brand hues clear the contrast floor
 *  on the zinc-900 surface. */
function senderColor(name: string): string | undefined {
  const bg = agentIconFor(name)?.bg;
  return bg ? `color-mix(in srgb, ${bg} 62%, white)` : undefined;
}

/** Inline-highlight @mentions inside an excerpt (the handoff cue: a bot
 *  @-ing another bot reads at a glance). Pure text styling — still inert. */
const MENTION_RE = /(@[\p{L}\p{N}_.-]+)/gu;
function renderExcerpt(text: string): ReactNode {
  if (!text.includes("@")) return text;
  return text.split(MENTION_RE).map((part, i) =>
    part.startsWith("@") ? (
      <span key={i} className="text-indigo-300">
        {part}
      </span>
    ) : (
      part
    )
  );
}

function MessageRow({
  n,
  memberOf,
  onJump,
}: {
  n: NormEvent;
  memberOf: MemberLookup;
  onJump?: (msgId: string) => void;
}) {
  const actor = memberOf(n.actorId);
  const name = nameOf(actor, n.actorId);
  const brand = n.actorType === "bot" ? senderColor(name) : undefined;
  const clickable = Boolean(n.msgId && onJump);

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => n.msgId && onJump?.(n.msgId)}
      title={clickable ? "Jump to this message" : undefined}
      className={cn(
        "group w-full flex items-baseline gap-1.5 py-[3px] text-left rounded",
        clickable && "hover:bg-zinc-800/40"
      )}
    >
      <span
        className={cn("text-[11px] font-medium flex-shrink-0", !brand && "text-zinc-300")}
        style={brand ? { color: brand } : undefined}
      >
        {name}
      </span>
      <span className="flex-1 min-w-0 truncate text-[11px] text-zinc-400">{renderExcerpt(n.excerpt)}</span>
      {n.fileCount > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-400 flex-shrink-0">
          <Paperclip className="w-2.5 h-2.5" />
          {n.fileCount}
        </span>
      )}
      {/* Hover swaps the timestamp for the jump arrow — one trailing slot, no shift. */}
      <span
        className={cn(
          "text-[10px] text-zinc-400 tabular-nums flex-shrink-0",
          clickable && "group-hover:hidden"
        )}
      >
        {fmtTime(n.ts)}
      </span>
      {clickable && (
        <ArrowUpRight className="w-3 h-3 self-center flex-shrink-0 text-indigo-300 hidden group-hover:block" />
      )}
    </button>
  );
}

function EpisodeDetail({
  ep,
  memberOf,
  onJump,
}: {
  ep: Episode;
  memberOf: MemberLookup;
  onJump?: (msgId: string) => void;
}) {
  const rows = useMemo(() => detailRows(ep), [ep]);
  const summary = episodeSummary(ep);
  return (
    <div className="px-3 pb-2">
      {summary && <div className="pl-[26px] pb-1 text-[10px] text-zinc-400">{summary}</div>}
      <div className="ml-[7px] border-l-2 border-zinc-800 pl-3">
        {rows.map((row, i) => {
          if (row.type === "muted") {
            const Icon = row.items.some((it) => it.kind === "write") ? Pencil : ShieldCheck;
            return (
              <div key={`m-${row.seq}-${i}`} className="flex items-baseline gap-1.5 py-[3px]">
                <Icon className="w-3 h-3 text-zinc-500 self-center flex-shrink-0" />
                <span className="min-w-0 truncate text-[10px] text-zinc-400">
                  {row.items.map((it, j) => (
                    <span key={j}>
                      {j > 0 && " · "}
                      <span className="text-zinc-300">{nameOf(memberOf(it.actorId), it.actorId)}</span>{" "}
                      {it.kind === "write"
                        ? `wrote ${it.count} file${it.count > 1 ? "s" : ""}`
                        : `approved${it.count > 1 ? ` ×${it.count}` : ""}`}
                    </span>
                  ))}
                </span>
              </div>
            );
          }
          return <MessageRow key={row.n.msgId ?? `e-${row.n.seq}-${i}`} n={row.n} memberOf={memberOf} onJump={onJump} />;
        })}
      </div>
    </div>
  );
}

// ── one episode in the flow list: collapsed line + inline expansion ─────────
function FlowEpisode({
  ep,
  memberOf,
  expanded,
  onToggle,
  onJump,
}: {
  ep: Episode;
  memberOf: MemberLookup;
  expanded: boolean;
  onToggle?: () => void;
  onJump?: (msgId: string) => void;
}) {
  return (
    <div className={cn(expanded && "bg-indigo-600/[0.08]")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
          !expanded && "hover:bg-zinc-800/40"
        )}
      >
        <ChainAvatars ep={ep} memberOf={memberOf} />
        <span
          className={cn(
            "flex-1 min-w-0 truncate text-[11px]",
            expanded ? "text-zinc-100" : "text-zinc-400"
          )}
        >
          {episodeTitle(ep, memberOf)}
        </span>
        <span className="text-[10px] text-zinc-400 tabular-nums flex-shrink-0">{fmtTime(ep.startTs)}</span>
      </button>
      {expanded && <EpisodeDetail ep={ep} memberOf={memberOf} onJump={onJump} />}
    </div>
  );
}

// ── participant strip: "who's here", recency-ordered avatar stack ──────────
// A collaboration-focused overview the flow list alone doesn't give you: every
// human/bot that's touched this channel, most-recently-active first, with
// presence — and a one-click way to spotlight just their activity (reuses the
// same `selected` filter the list/MemberFilter already read).
const PARTICIPANT_STRIP_CAP = 10;

function ParticipantStrip({
  ids,
  memberOf,
  selected,
  onToggle,
}: {
  ids: string[];
  memberOf: MemberLookup;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const shown = ids.slice(0, PARTICIPANT_STRIP_CAP);
  const overflow = ids.length - shown.length;
  const dim = selected.size > 0;
  const online = ids.reduce((n, id) => n + (memberOf(id)?.is_online ? 1 : 0), 0);

  return (
    <div className="mx-2 mt-2 flex flex-shrink-0 items-center gap-1 rounded-lg bg-zinc-900/50 px-2 py-1.5">
      <div className="flex items-center -space-x-2">
        {shown.map((id) => {
          const mem = memberOf(id);
          const name = nameOf(mem, id);
          const active = selected.has(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => onToggle(id)}
              title={`${name}${mem?.is_online != null ? (mem.is_online ? " · online" : " · offline") : ""}`}
              aria-label={`Filter by ${name}`}
              aria-pressed={active}
              className={cn(
                "relative rounded-full ring-2 transition-all",
                active ? "ring-indigo-500" : "ring-zinc-900",
                dim && !active && "opacity-50 hover:opacity-100"
              )}
            >
              <Avatar
                name={name}
                src={mem?.avatar_url ?? undefined}
                id={id}
                online={mem?.is_online ?? undefined}
                size="xs"
                className="!w-6 !h-6"
              />
            </button>
          );
        })}
      </div>
      {overflow > 0 && (
        <span className="ml-1 text-[10px] text-zinc-400 flex-shrink-0">+{overflow}</span>
      )}
      {online > 0 && <span className="ml-1.5 text-[10px] text-zinc-400 flex-shrink-0">{online} online</span>}
    </div>
  );
}

// ── the board ────────────────────────────────────────────────────────────────
function ActivityBody({ ctx }: { ctx: ViewBoardContext }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [lens, setLens] = useState<Lens>("flow");
  // undefined = auto (newest episode expanded); null = user collapsed everything.
  const [expandedId, setExpandedId] = useState<string | null | undefined>(undefined);
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
  useBoardTickRefetch(ctx, "activity", load);

  const byId = useMemo(() => {
    const m = new Map<string, MemberItem>();
    for (const mem of members) m.set(mem.member_id, mem);
    return m;
  }, [members]);
  const memberOf: MemberLookup = useCallback((id) => (id ? byId.get(id) : undefined), [byId]);
  const isBot = useCallback((id?: string | null) => memberOf(id)?.member_type === "bot", [memberOf]);

  const allEpisodes = useMemo(
    () => (events ? buildEpisodes(events, isBot) : []),
    [events, isBot]
  );

  // Distinct participants across the WHOLE channel (not lens-filtered), most-
  // recently-active first — episodes are already newest-first, so the first
  // time an id shows up while walking them is its most recent activity.
  const participantIds = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const ep of allEpisodes) {
      for (const id of ep.participants) {
        if (!seen.has(id)) {
          seen.add(id);
          order.push(id);
        }
      }
    }
    return order;
  }, [allEpisodes]);

  // Member filter → then the lens filter (Highlights drops chatter-only episodes).
  const episodes = useMemo(() => {
    let eps = allEpisodes;
    if (selected.size) eps = eps.filter((ep) => episodeTouches(ep, selected));
    if (lens === "highlights") eps = eps.filter(isNotableEpisode);
    return eps;
  }, [allEpisodes, selected, lens]);

  // Auto-expand the newest episode until the user picks/collapses one themselves.
  const effectiveExpanded =
    lens === "all" ? null : expandedId === undefined ? (episodes[0]?.id ?? null) : expandedId;
  const toggleEpisode = useCallback(
    (id: string) => setExpandedId((prev) => {
      const cur = prev === undefined ? (episodes[0]?.id ?? null) : prev;
      return cur === id ? null : id;
    }),
    [episodes]
  );

  return (
    <ViewBoardShell title="Activity" icon={Activity} loading={loading} onRefresh={() => void load()}>
      <div className="flex flex-col h-full min-h-0">
        {participantIds.length > 1 && (
          <ParticipantStrip
            ids={participantIds}
            memberOf={memberOf}
            selected={selected}
            onToggle={toggleMember}
          />
        )}
        {events == null ? (
          <div className="flex-1">
            <SurfaceSpinner />
          </div>
        ) : episodes.length === 0 ? (
          <div className="flex-1">
            <EmptyState
              icon={Activity}
              title={
                selected.size || lens === "highlights"
                  ? "No activity matches this view."
                  : "No activity yet"
              }
              hint={
                selected.size || lens === "highlights"
                  ? undefined
                  : "Messages and operations will appear here."
              }
            />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto py-1">
            {episodes.map((ep) => (
              <FlowEpisode
                key={ep.id}
                ep={ep}
                memberOf={memberOf}
                expanded={lens === "all" || effectiveExpanded === ep.id}
                onToggle={lens === "all" ? undefined : () => toggleEpisode(ep.id)}
                onJump={ctx.onJumpToMessage}
              />
            ))}
          </div>
        )}

        {/* Footer: lens tabs (left) + member filter (right). */}
        <div className="mx-2 mb-2 flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900/50 px-2 py-1.5">
          <div className="flex items-center gap-0.5 rounded-full bg-zinc-900/60 p-0.5">
            {(["flow", "highlights", "all"] as Lens[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLens(l)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[10px] capitalize transition-colors",
                  lens === l ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
                )}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {members.length > 0 && (
            <MemberFilter
              members={members}
              memberOf={memberOf}
              selected={selected}
              onToggle={toggleMember}
              onClear={clearSelection}
              openUp
            />
          )}
        </div>
      </div>
    </ViewBoardShell>
  );
}

// ── member filter (shared popover primitive; avatars with presence) ─────────
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
      className={cn(
        "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] whitespace-nowrap flex-shrink-0 border transition-colors",
        active
          ? "border-zinc-600 bg-zinc-800 text-zinc-200"
          : "border-transparent bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
      )}
    >
      {children}
    </button>
  );
}

function MemberFilter({
  members,
  memberOf,
  selected,
  onToggle,
  onClear,
  openUp,
}: {
  members: MemberItem[];
  memberOf: MemberLookup;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  openUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);

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
    <div ref={rootRef} className="relative flex-shrink-0">
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
        <span>{selected.size ? `${selected.size}` : "Filter"}</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <PopoverPanel placement={openUp ? "up" : "down"} align="end" className="w-60 max-w-[calc(100vw-2rem)]">
          <div className="m-1 flex items-center gap-1.5 rounded-md bg-zinc-800/50 px-2 py-1.5">
            <Search className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search members…"
              className="flex-1 min-w-0 bg-transparent text-xs text-zinc-200 placeholder:text-zinc-400 outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {shown.length === 0 ? (
              <div className="px-3 py-3 text-center text-[11px] text-zinc-400">No members match.</div>
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
                      online={mem.is_online ?? undefined}
                      size="xs"
                      className="!w-4 !h-4"
                    />
                    <span className="flex-1 truncate text-xs text-zinc-300">
                      {mem.display_name || mem.username || short(mem.member_id)}
                    </span>
                    {mem.member_type === "bot" && (
                      <span className="text-[10px] uppercase tracking-wide text-zinc-400 flex-shrink-0">bot</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
          {selected.size > 0 && (
            <div className="m-1 mt-2 flex items-center gap-2 rounded-md bg-zinc-800/50 px-2 py-1.5">
              <div className="flex-1 flex flex-wrap gap-1">
                {members
                  .filter((mem) => selected.has(mem.member_id))
                  .map((mem) => (
                    <FilterChip key={mem.member_id} active onClick={() => onToggle(mem.member_id)}>
                      <span className="truncate max-w-[70px]">
                        {nameOf(memberOf(mem.member_id), mem.member_id)}
                      </span>
                      <X className="w-2.5 h-2.5 opacity-60" />
                    </FilterChip>
                  ))}
              </div>
              <button
                type="button"
                onClick={onClear}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors flex-shrink-0"
              >
                Clear
              </button>
            </div>
          )}
        </PopoverPanel>
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
