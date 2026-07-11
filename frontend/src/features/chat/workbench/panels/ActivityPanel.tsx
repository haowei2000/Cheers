// Activity — the channel's HISTORY at two zoom levels (Codex-sidebar-style):
// a NODE RAIL on the left compresses the whole channel into one scannable
// column (one node per episode), and a DETAIL pane on the right expands just the
// selected episode. An "episode" is a causal unit — a human's @mention plus the
// bot turn / approvals / file writes that follow it (see activityEpisodes.ts) —
// so the board reads as "what happened", not a firehose of rows. Three lenses:
// Episodes (one node per episode), Highlights (only episodes that made a
// decision / artifact), All (every event, low-signal bursts collapsed to ×N).
// Clicking a message in the detail pane jumps the chat to it (ctx.onJumpToMessage).
// Sourced from `channel.activity.read` (messages ∪ operations) + REST
// listChannelMembers (id → name + avatar_url). All content is inert text.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AtSign,
  FileText,
  Filter,
  Paperclip,
  Pencil,
  Search,
  ShieldCheck,
  Check,
  ChevronDown,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { avatarColor } from "@/lib/format";
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
  collapseEpisode,
  isNotableEpisode,
  type ActivityEvent,
  type Episode,
  type EventKind,
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

/** Whole-minute span between two ISO stamps, e.g. "8 min" / "" if <1min. */
function fmtSpan(a?: string | null, b?: string | null): string {
  if (!a || !b) return "";
  const t0 = Date.parse(a);
  const t1 = Date.parse(b);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return "";
  const min = Math.round(Math.abs(t1 - t0) / 60000);
  return min >= 1 ? `${min} min` : "";
}

type MemberLookup = (id?: string | null) => MemberItem | undefined;

function nameOf(member: MemberItem | undefined, id?: string | null): string {
  return member?.display_name || member?.username || short(id) || "unknown";
}

type Lens = "episodes" | "highlights" | "all";

// ── episode helpers that need the member map (kept out of the pure module) ──
function episodeTitle(ep: Episode, memberOf: MemberLookup): string {
  if (ep.title) return ep.title;
  const dom = memberOf(ep.dominantActorId);
  return `${nameOf(dom, ep.dominantActorId)} activity`;
}

/** Human-readable one-liner of what an episode produced, for the rail sub-label. */
function episodeSummary(ep: Episode): string {
  const p: string[] = [];
  if (ep.counts.messages) p.push(`${ep.counts.messages} msg`);
  if (ep.counts.approvals) p.push(`${ep.counts.approvals} approval${ep.counts.approvals > 1 ? "s" : ""}`);
  if (ep.counts.writes) p.push(`${ep.counts.writes} write${ep.counts.writes > 1 ? "s" : ""}`);
  if (ep.counts.files) p.push(`${ep.counts.files} file${ep.counts.files > 1 ? "s" : ""}`);
  return p.join(" · ");
}

/** Does this episode touch ANY of the selected member ids (participant or @)? */
function episodeTouches(ep: Episode, selected: Set<string>): boolean {
  for (const id of ep.participants) if (selected.has(id)) return true;
  for (const n of ep.events) for (const m of n.mentions) if (selected.has(m.member_id)) return true;
  return false;
}

// ── the node rail ───────────────────────────────────────────────────────────
// One node per row: a small marker + a SHORT type label ("claude turn",
// "approval", "10 writes"). Everything else (excerpt, counts, time) lives in the
// hover bubble + the detail pane — the rail itself stays scannable at a glance.
interface RailMarker {
  bar?: boolean; // gray burst bar (writes / ops) vs. a colored dot
  color?: string; // dot fill (brand color) via inline style
  cls?: string; // dot fill via tailwind class (per-actor hash / semantic)
}
interface RailTip {
  id?: string | null;
  name: string;
  time: string;
  summary: string;
}
interface RailItem {
  key: string;
  episodeId: string;
  marker: RailMarker;
  label: string;
  tip: RailTip;
}

/** Dot fill for an actor: brand color for known agents, else a stable hash. */
function actorMarker(id?: string | null, name?: string): RailMarker {
  const brand = agentIconFor(name);
  if (brand) return { color: brand.bg };
  return { cls: avatarColor(id ?? name ?? "") };
}

function Marker({ marker }: { marker: RailMarker }) {
  if (marker.bar) return <span className="w-4 h-[3px] rounded-full bg-zinc-600 flex-shrink-0" />;
  return (
    <span
      className={cn("w-2 h-2 rounded-full flex-shrink-0", marker.cls)}
      style={marker.color ? { backgroundColor: marker.color } : undefined}
    />
  );
}

/** One episode → one rail node ("{bot} turn", or the human's name for a
 *  human-only run). Used by the Episodes + Highlights lenses. */
function episodeItem(ep: Episode, memberOf: MemberLookup): RailItem {
  const dom = memberOf(ep.dominantActorId);
  const domName = nameOf(dom, ep.dominantActorId);
  const hasBot = !!ep.dominantActorId && dom?.member_type === "bot";
  const trig = memberOf(ep.triggerActorId);
  const label = hasBot ? `${domName} turn` : nameOf(trig, ep.triggerActorId);
  const summary = [episodeTitle(ep, memberOf), episodeSummary(ep)].filter(Boolean).join(" · ");
  return {
    key: ep.id,
    episodeId: ep.id,
    marker: actorMarker(ep.dominantActorId ?? ep.triggerActorId, hasBot ? domName : label),
    label,
    tip: {
      id: ep.dominantActorId ?? ep.triggerActorId,
      name: hasBot ? domName : nameOf(trig, ep.triggerActorId),
      time: fmtTime(ep.startTs),
      summary,
    },
  };
}

/** One collapsed run → one rail node. Used by the All lens. */
function runItem(run: ReturnType<typeof collapseEpisode>[number], memberOf: MemberLookup): RailItem {
  const actor = memberOf(run.actorId);
  const name = nameOf(actor, run.actorId);
  let marker: RailMarker;
  let label: string;
  switch (run.kind) {
    case "write":
      marker = { bar: true };
      label = `${run.count} write${run.count > 1 ? "s" : ""}`;
      break;
    case "op":
      marker = { bar: true };
      label = `${run.count} op${run.count > 1 ? "s" : ""}`;
      break;
    case "approval":
      marker = { cls: "bg-emerald-500" };
      label = "approval";
      break;
    case "file":
      marker = { cls: "bg-sky-500" };
      label = "file";
      break;
    case "bot_msg":
      marker = actorMarker(run.actorId, name);
      label = `${name} turn`;
      break;
    default: // trigger / user_msg
      marker = actorMarker(run.actorId, name);
      label = run.count > 1 ? `${name} ×${run.count}` : name;
  }
  return {
    key: run.key,
    episodeId: run.episodeId,
    marker,
    label,
    tip: { id: run.actorId, name, time: fmtTime(run.ts), summary: run.sample || label },
  };
}

function RailRow({
  item,
  active,
  onSelect,
  onHover,
  onLeave,
}: {
  item: RailItem;
  active: boolean;
  onSelect: () => void;
  onHover: (rect: DOMRect, item: RailItem) => void;
  onLeave: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={(e) => onHover(e.currentTarget.getBoundingClientRect(), item)}
      onMouseLeave={onLeave}
      className={cn(
        "w-full text-left flex items-center gap-2.5 rounded-md px-2 py-1 transition-colors",
        active ? "bg-indigo-600/15" : "hover:bg-zinc-800/40"
      )}
    >
      <Marker marker={item.marker} />
      <span className={cn("min-w-0 flex-1 truncate text-[11px]", active ? "text-zinc-100" : "text-zinc-400")}>
        {item.label}
      </span>
    </button>
  );
}

/** Fixed-position hover bubble — escapes the rail's scroll clipping. */
function RailTooltip({ rect, item, memberOf }: { rect: DOMRect; item: RailItem; memberOf: MemberLookup }) {
  return (
    <div
      style={{ position: "fixed", left: Math.round(rect.right + 8), top: Math.round(rect.top - 4), zIndex: 60 }}
      className="w-52 max-w-[calc(100vw-1rem)] rounded-lg bg-zinc-800 shadow-xl shadow-black/40 p-2.5 pointer-events-none"
    >
      <div className="flex items-center gap-2 mb-1">
        <Avatar
          name={item.tip.name}
          src={memberOf(item.tip.id)?.avatar_url ?? undefined}
          id={item.tip.id ?? item.key}
          size="xs"
          className="!w-4 !h-4"
        />
        <span className="text-xs font-medium text-zinc-100 truncate">{item.tip.name}</span>
        {item.tip.time && <span className="ml-auto text-[10px] text-zinc-400 flex-shrink-0">{item.tip.time}</span>}
      </div>
      {item.tip.summary && <div className="text-[11px] text-zinc-400 leading-snug">{item.tip.summary}</div>}
    </div>
  );
}

// ── detail pane: the selected episode, fully expanded ───────────────────────
type DetailRow =
  | { type: "event"; n: NormEvent }
  | { type: "writeRun"; count: number; actorId?: string | null; seq: number };

/** Fold consecutive write/op events into one summary row; keep messages
 *  individually rendered (so each stays jump-to-able). */
function detailRows(ep: Episode): DetailRow[] {
  const rows: DetailRow[] = [];
  for (const n of ep.events) {
    if (n.kind === "write" || n.kind === "op") {
      const last = rows[rows.length - 1];
      if (last && last.type === "writeRun" && last.actorId === n.actorId) {
        last.count += 1;
        last.seq = n.seq;
      } else {
        rows.push({ type: "writeRun", count: 1, actorId: n.actorId, seq: n.seq });
      }
    } else {
      rows.push({ type: "event", n });
    }
  }
  return rows.reverse(); // newest-first, matching the rest of the board
}

function KindIcon({ kind }: { kind: EventKind }) {
  if (kind === "approval") return <ShieldCheck className="w-3.5 h-3.5 text-emerald-400/80" />;
  if (kind === "file") return <Paperclip className="w-3.5 h-3.5 text-zinc-400" />;
  if (kind === "trigger") return <AtSign className="w-3.5 h-3.5 text-indigo-300/80" />;
  return <FileText className="w-3.5 h-3.5 text-zinc-500" />;
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
  const trigger = memberOf(ep.triggerActorId);
  const dom = memberOf(ep.dominantActorId);
  const rows = useMemo(() => detailRows(ep), [ep]);
  const span = fmtSpan(ep.startTs, ep.endTs);

  // The first bot the trigger addressed, for the "X → @Y" header line.
  const firstMention = ep.events.find((n) => n.kind === "trigger")?.mentions[0];
  const mentioned = firstMention ? memberOf(firstMention.member_id) : dom;

  return (
    <div className="rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/50 border-b border-zinc-800">
        <Avatar
          name={nameOf(trigger ?? dom, ep.triggerActorId ?? ep.dominantActorId)}
          src={(trigger ?? dom)?.avatar_url ?? undefined}
          id={ep.triggerActorId ?? ep.dominantActorId ?? ep.id}
          size="xs"
        />
        <span className="text-xs text-zinc-200 min-w-0 truncate">
          <span className="font-medium">
            {nameOf(trigger ?? dom, ep.triggerActorId ?? ep.dominantActorId)}
          </span>
          {ep.triggerActorId && mentioned && (
            <>
              <span className="text-zinc-600"> → </span>
              <span className="text-indigo-300">@{nameOf(mentioned, firstMention?.member_id)}</span>
            </>
          )}
        </span>
        <span className="ml-auto text-[10px] text-zinc-400 tabular-nums whitespace-nowrap flex-shrink-0">
          {fmtTime(ep.startTs)}
          {span && ` · ${span}`}
        </span>
      </div>

      <div className="px-3 py-1">
        {rows.map((row, i) => {
          if (row.type === "writeRun") {
            const actor = memberOf(row.actorId);
            return (
              <div key={`w-${row.seq}-${i}`} className="flex items-center gap-2 py-1.5 border-b border-zinc-900 last:border-0">
                <span className="w-5 flex justify-center flex-shrink-0">
                  <Pencil className="w-3.5 h-3.5 text-zinc-500" />
                </span>
                <span className="text-[11px] text-zinc-400">
                  <span className="text-zinc-300">{nameOf(actor, row.actorId)}</span> wrote{" "}
                  {row.count} file{row.count > 1 ? "s" : ""}
                </span>
              </div>
            );
          }
          const n = row.n;
          const actor = memberOf(n.actorId);
          const isMsg = n.kind === "trigger" || n.kind === "user_msg" || n.kind === "bot_msg" || n.kind === "file";
          const clickable = Boolean(n.msgId && onJump);
          return (
            <button
              key={n.msgId ?? `e-${n.seq}-${i}`}
              type="button"
              disabled={!clickable}
              onClick={() => n.msgId && onJump?.(n.msgId)}
              title={clickable ? "Jump to this message" : undefined}
              className={cn(
                "w-full text-left flex items-start gap-2 py-1.5 border-b border-zinc-900 last:border-0",
                clickable && "hover:bg-zinc-800/40 rounded"
              )}
            >
              {isMsg ? (
                <Avatar
                  name={nameOf(actor, n.actorId)}
                  src={actor?.avatar_url ?? undefined}
                  id={n.actorId ?? String(n.seq)}
                  size="xs"
                  className="mt-0.5 flex-shrink-0"
                />
              ) : (
                <span className="w-5 flex justify-center mt-0.5 flex-shrink-0">
                  <KindIcon kind={n.kind} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[11px] font-medium text-zinc-300 truncate">
                    {nameOf(actor, n.actorId)}
                  </span>
                  {n.kind === "approval" && (
                    <span className="text-[10px] text-emerald-400/80">approval</span>
                  )}
                  {n.fileCount > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-400">
                      <Paperclip className="w-2.5 h-2.5" />
                      {n.fileCount}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-zinc-400 tabular-nums flex-shrink-0">
                    {fmtTime(n.ts)}
                  </span>
                </div>
                {n.excerpt && <div className="text-[11px] text-zinc-400 truncate mt-px">{n.excerpt}</div>}
                {n.mentions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {n.mentions.map((m) => (
                      <span
                        key={m.member_id}
                        className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] bg-indigo-500/10 text-indigo-300/90"
                      >
                        <AtSign className="w-2.5 h-2.5" />
                        {nameOf(memberOf(m.member_id), m.member_id)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── the board ────────────────────────────────────────────────────────────────
function ActivityBody({ ctx }: { ctx: ViewBoardContext }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [lens, setLens] = useState<Lens>("episodes");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [hover, setHover] = useState<{ rect: DOMRect; item: RailItem } | null>(null);

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

  // Member filter → then the lens filter (Highlights drops chatter-only episodes).
  const episodes = useMemo(() => {
    let eps = allEpisodes;
    if (selected.size) eps = eps.filter((ep) => episodeTouches(ep, selected));
    if (lens === "highlights") eps = eps.filter(isNotableEpisode);
    return eps;
  }, [allEpisodes, selected, lens]);

  // Keep a valid selection: default to the newest episode; re-point if it vanished.
  useEffect(() => {
    if (!episodes.length) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !episodes.some((ep) => ep.id === selectedId)) {
      setSelectedId(episodes[0].id);
    }
  }, [episodes, selectedId]);

  const selectedEpisode = episodes.find((ep) => ep.id === selectedId) ?? episodes[0] ?? null;

  // Rail items: one node per episode (episodes/highlights), or one per collapsed
  // run (all). Each is a short typed label; details live in the hover bubble.
  const railItems = useMemo<RailItem[]>(() => {
    if (lens === "all") return episodes.flatMap((ep) => collapseEpisode(ep).map((run) => runItem(run, memberOf)));
    return episodes.map((ep) => episodeItem(ep, memberOf));
  }, [episodes, lens, memberOf]);

  const onHover = useCallback((rect: DOMRect, item: RailItem) => setHover({ rect, item }), []);
  const onLeave = useCallback(() => setHover(null), []);

  return (
    <ViewBoardShell title="Activity" icon={Activity} loading={loading} onRefresh={() => void load()}>
      <div className="flex flex-col h-full min-h-0">
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
          <div className="grid grid-cols-[minmax(112px,38%)_1fr] flex-1 min-h-0" onMouseLeave={onLeave}>
            {/* Rail — the whole channel, one short node per row. */}
            <div className="overflow-y-auto border-r border-zinc-900 p-1.5 space-y-0.5">
              <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-zinc-400">
                rail · whole channel
              </div>
              {railItems.map((item) => (
                <RailRow
                  key={item.key}
                  item={item}
                  active={item.episodeId === selectedId}
                  onSelect={() => setSelectedId(item.episodeId)}
                  onHover={onHover}
                  onLeave={onLeave}
                />
              ))}
            </div>

            {/* Detail — the selected episode, expanded. */}
            <div className="overflow-y-auto p-2">
              {selectedEpisode ? (
                <EpisodeDetail ep={selectedEpisode} memberOf={memberOf} onJump={ctx.onJumpToMessage} />
              ) : (
                <div className="px-3 py-6 text-center text-xs text-zinc-400">
                  Select an episode to see its detail.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer: lens tabs (left) + member filter (right) — mirrors the mock. */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-0.5 rounded-full bg-zinc-900/60 p-0.5">
            {(["episodes", "highlights", "all"] as Lens[]).map((l) => (
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
      {/* Portalled to <body>: the ViewBoard window is a transformed,
          overflow-hidden containing block that would otherwise clip a fixed
          child (and re-anchor its coordinates). */}
      {hover &&
        createPortal(
          <RailTooltip rect={hover.rect} item={hover.item} memberOf={memberOf} />,
          document.body
        )}
    </ViewBoardShell>
  );
}

// ── member filter (unchanged behavior; avatars from last redesign) ──────────
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
          : "border-transparent bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
      }`}
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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-activity-filter-root]")) setOpen(false);
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
        <span>{selected.size ? `${selected.size}` : "Filter"}</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          className={cn(
            "absolute right-0 z-50 w-60 max-w-[calc(100vw-2rem)] rounded-xl bg-zinc-900 shadow-xl shadow-black/40",
            openUp ? "bottom-full mb-1.5" : "top-full mt-1.5"
          )}
        >
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-zinc-800">
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
            <div className="border-t border-zinc-800 px-2 py-1.5 flex items-center gap-2">
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
