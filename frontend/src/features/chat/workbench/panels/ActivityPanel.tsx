// Activity — an INTERACTION LANE diagram of the channel (sequence-diagram style):
// each member owns a vertical column (a lifeline), and every @mention or reply is a
// horizontal arrow from the sender's column to the target's column, ordered by time
// (newest at top). One message that @mentions several members draws several arrows
// (one-to-many); a reply draws an arrow to the replied message's author. Color =
// mention vs reply. Sourced from `channel.activity.read` (messages) + `channel.members`
// (id -> name). All ids/names are agent-authored and render as inert SVG text. A
// multi-select member filter (the "Filter members" dropdown, or clicking a column
// header) narrows the lanes to interactions that touch ANY of the selected members —
// so you can isolate one person or compare a few.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Cog,
  User,
  Filter,
  Search,
  Check,
  ChevronDown,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  registerComponentViewBoard,
  useBoardTickRefetch,
  ViewBoardShell,
  type ViewBoardContext,
} from "../viewBoard";

type ActorType = "user" | "bot" | "system";

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
  actor_type?: ActorType;
  actor_id?: string | null;
  created_at?: string;
}

interface ActivityEvent {
  event_type: "message" | "operation";
  channel_seq: number;
  created_at?: string | null;
  data: MessageData & OperationData;
}

interface Member {
  member_id: string;
  member_type: "user" | "bot";
  display_name?: string | null;
  username?: string | null;
}

interface MemberInfo {
  name: string;
  type: "user" | "bot";
}

type EdgeType = "mention" | "reply";
/** One directed interaction = one arrow (one row) in the lane diagram. */
interface Interaction {
  source: string;
  target: string;
  type: EdgeType;
  ts?: string | null;
}

const MENTION = "rgb(129 140 248)"; // indigo-400
const REPLY = "rgb(52 211 153)"; // emerald-400
const MAX_ROWS = 80; // cap the number of lanes so a busy channel stays readable

// Lane-diagram geometry.
const MARGIN_X = 48;
const COL_GAP = 96;
const HEADER_H = 34;
const ROW_H = 22;

function short(id?: string | null): string {
  return typeof id === "string" && id ? id.slice(0, 8) : "";
}

function actorStyle(type: ActorType): { Icon: LucideIcon; dot: string } {
  if (type === "bot") return { Icon: Bot, dot: "bg-violet-400" };
  if (type === "system") return { Icon: Cog, dot: "bg-zinc-500" };
  return { Icon: User, dot: "bg-sky-400" };
}

/** Flatten events into directed interactions (newest first). Each @mention and each
 *  reply becomes one arrow. `involved` = every member that sends or receives one. */
function buildInteractions(events: ActivityEvent[]): {
  involved: Set<string>;
  rows: Interaction[];
} {
  // msg_id -> author, so a reply can resolve to whom it replied to.
  const author = new Map<string, string>();
  for (const e of events) {
    if (e.event_type === "message" && e.data.msg_id && e.data.sender_id) {
      author.set(e.data.msg_id, e.data.sender_id);
    }
  }
  const rows: Interaction[] = [];
  const involved = new Set<string>();
  const push = (
    source?: string | null,
    target?: string | null,
    type?: EdgeType,
    ts?: string | null
  ) => {
    if (!source || !target || !type || source === target) return;
    rows.push({ source, target, type, ts });
    involved.add(source);
    involved.add(target);
  };
  // Events arrive newest-first (desc), so `rows` inherits that order.
  for (const e of events) {
    if (e.event_type !== "message") continue;
    const a = e.data.sender_id;
    const ts = e.data.created_at ?? e.created_at;
    for (const m of e.data.mentions ?? []) push(a, m.member_id, "mention", ts);
    if (e.data.reply_to_msg_id) push(a, author.get(e.data.reply_to_msg_id), "reply", ts);
  }
  return { involved, rows };
}

function fmtTime(ts?: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function InteractionGraph({
  members,
  memberMap,
  involved,
  rows: allRows,
  selected,
  onToggle,
}: {
  members: Member[];
  memberMap: Map<string, MemberInfo>;
  involved: Set<string>;
  rows: Interaction[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  // Columns = involved members, in stable member order — one lane per person.
  const cols = useMemo(
    () => members.map((m) => m.member_id).filter((id) => involved.has(id)),
    [members, involved]
  );

  // The selected members filter the lanes down to interactions that touch ANY of them
  // (union) — empty selection shows everyone.
  const rows = useMemo(() => {
    const r = selected.size
      ? allRows.filter((x) => selected.has(x.source) || selected.has(x.target))
      : allRows;
    return r.slice(0, MAX_ROWS);
  }, [allRows, selected]);

  // Columns still touched by the (possibly filtered) rows — others dim out.
  const activeCols = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      s.add(r.source);
      s.add(r.target);
    }
    return s;
  }, [rows]);

  const colX = useMemo(() => {
    const m = new Map<string, number>();
    cols.forEach((id, i) => m.set(id, MARGIN_X + i * COL_GAP));
    return m;
  }, [cols]);

  if (cols.length < 2 || allRows.length === 0) {
    return (
      <div className="px-3 py-10 text-center text-xs text-zinc-600">
        No @mentions or replies yet — interactions will draw as lanes here.
      </div>
    );
  }

  const W = MARGIN_X * 2 + COL_GAP * Math.max(0, cols.length - 1);
  const H = HEADER_H + rows.length * ROW_H + 10;
  const laneTop = HEADER_H - 4;
  const laneBottom = H - 6;

  return (
    <div className="p-2">
      <div className="overflow-x-auto">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="mx-auto block">
          <defs>
            <marker id="arw-mention" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill={MENTION} />
            </marker>
            <marker id="arw-reply" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill={REPLY} />
            </marker>
          </defs>

          {/* Lifelines — one vertical lane per member. */}
          {cols.map((id) => {
            const x = colX.get(id)!;
            const on = activeCols.has(id);
            return (
              <line
                key={`lane-${id}`}
                x1={x}
                y1={laneTop}
                x2={x}
                y2={laneBottom}
                stroke={selected.has(id) ? "rgb(82 82 91)" : "rgb(39 39 42)"}
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={on ? 1 : 0.4}
              />
            );
          })}

          {/* Column headers (dot + name), clickable to filter. */}
          {cols.map((id) => {
            const x = colX.get(id)!;
            const info = memberMap.get(id);
            const isBot = info?.type === "bot";
            const on = activeCols.has(id);
            const sel = selected.has(id);
            const label = (info?.name ?? short(id)).slice(0, 11);
            return (
              <g
                key={`hd-${id}`}
                onClick={() => onToggle(id)}
                style={{ cursor: "pointer" }}
                opacity={on ? 1 : 0.35}
              >
                <circle
                  cx={x}
                  cy={9}
                  r={4}
                  fill={isBot ? "rgb(196 181 253)" : "rgb(125 211 252)"}
                  stroke={sel ? "white" : "rgb(24 24 27)"}
                  strokeWidth={sel ? 1.5 : 1}
                />
                <text
                  x={x}
                  y={24}
                  textAnchor="middle"
                  fontSize="9"
                  fontWeight={sel ? 600 : 400}
                  fill={sel ? "rgb(228 228 231)" : "rgb(161 161 170)"}
                >
                  {label}
                </text>
              </g>
            );
          })}

          {/* Interaction arrows — one row per @mention / reply, newest at top. */}
          {rows.map((r, i) => {
            const sx = colX.get(r.source);
            const tx = colX.get(r.target);
            if (sx == null || tx == null) return null;
            const y = HEADER_H + i * ROW_H + ROW_H / 2;
            const dir = tx >= sx ? 1 : -1;
            const x2 = tx - dir * 4; // stop just short of the target lifeline
            const color = r.type === "mention" ? MENTION : REPLY;
            const sName = memberMap.get(r.source)?.name ?? short(r.source);
            const tName = memberMap.get(r.target)?.name ?? short(r.target);
            const t = fmtTime(r.ts);
            return (
              <g key={i}>
                <title>{`${sName} → ${tName} · ${r.type}${t ? ` · ${t}` : ""}`}</title>
                <line
                  x1={sx}
                  y1={y}
                  x2={x2}
                  y2={y}
                  stroke={color}
                  strokeWidth={1.6}
                  strokeOpacity={0.85}
                  markerEnd={`url(#arw-${r.type})`}
                />
                <circle cx={sx} cy={y} r={2.4} fill={color} />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-1.5 flex items-center justify-center gap-4 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-[2px] rounded" style={{ background: MENTION }} />
          @mention
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-[2px] rounded" style={{ background: REPLY }} />
          reply
        </span>
        <span className="text-zinc-600">
          ·{" "}
          {selected.size
            ? `showing ${selected.size} member${selected.size > 1 ? "s" : ""}`
            : "newest on top · click a column to filter"}
        </span>
      </div>
    </div>
  );
}

function ActivityBody({ ctx }: { ctx: ViewBoardContext }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  // Multi-select member filter: the set of member_ids whose interactions to show.
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
      ctx.sendResourceReq("channel.members", { channel_id: ctx.channelId }),
    ]);
    setEvents(
      activityRes.status === "fulfilled"
        ? ((activityRes.value as { events?: ActivityEvent[] })?.events ?? [])
        : []
    );
    if (membersRes.status === "fulfilled") {
      setMembers((membersRes.value as { members?: Member[] })?.members ?? []);
    }
    setLoading(false);
  }, [ctx.channelId, ctx.sendResourceReq]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-push: ChannelView bumps the "activity" tick on every new message.
  // Deferred while the board is kept-alive but hidden; catches up on reveal.
  useBoardTickRefetch(ctx, "activity", load);

  const memberMap = useMemo(() => {
    const m = new Map<string, MemberInfo>();
    for (const mem of members) {
      m.set(mem.member_id, {
        name: mem.display_name || mem.username || short(mem.member_id),
        type: mem.member_type,
      });
    }
    return m;
  }, [members]);

  const { involved, rows } = useMemo(
    () => buildInteractions(events ?? []),
    [events]
  );

  return (
    <ViewBoardShell title="Activity" icon={Activity} loading={loading} onRefresh={() => void load()}>
      {members.length > 0 && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-zinc-900">
          <MemberFilter
            members={members}
            selected={selected}
            onToggle={toggleMember}
            onClear={clearSelection}
          />
          {selected.size > 0 && (
            <div className="flex items-center gap-1 overflow-x-auto">
              {members
                .filter((mem) => selected.has(mem.member_id))
                .map((mem) => {
                  const style = actorStyle(mem.member_type);
                  return (
                    <FilterChip
                      key={mem.member_id}
                      active
                      onClick={() => toggleMember(mem.member_id)}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                      <span className="truncate max-w-[80px]">
                        {mem.display_name || mem.username || short(mem.member_id)}
                      </span>
                      <X className="w-2.5 h-2.5 opacity-60" />
                    </FilterChip>
                  );
                })}
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
      ) : (
        <InteractionGraph
          members={members}
          memberMap={memberMap}
          involved={involved}
          rows={rows}
          selected={selected}
          onToggle={toggleMember}
        />
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
  children: React.ReactNode;
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

/** Searchable multi-select of channel members. Replaces the old single-select chip row:
 *  with a large roster, scanning a horizontal chip strip to find one person is slow, so
 *  this is a "Filter members" button opening a searchable checkbox list. Selection lives
 *  in the parent (a Set of member_ids); the active picks also render as removable chips
 *  next to the button. Outside-click / Escape dismiss, same pattern as ComposerModelPopover. */
function MemberFilter({
  members,
  selected,
  onToggle,
  onClear,
}: {
  members: Member[];
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
                const style = actorStyle(mem.member_type);
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
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${style.dot}`} />
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
