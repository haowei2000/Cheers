import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ClipboardList,
  Coins,
  Layers,
  ShieldCheck,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { listApprovalAudit } from "@/api/approval";
import type { ViewBoardContext } from "./viewBoard";

// Compact number formatting for the glance (never the full precision the boards show).
function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

// channel.activity.read is windowed (we ask for the newest ACTIVITY_WINDOW events),
// so the glance shows "50+" when the window is full rather than a fake total.
const ACTIVITY_WINDOW = 50;

interface Summary {
  plan: { completed: number; total: number } | null;
  cost: { tokens: number; cost: number } | null;
  sessions: number | null;
  approvals: number | null;
  activity: { events: number; members: number } | null;
}

function GlanceRow({
  Icon,
  label,
  value,
  sub,
  bar,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  sub?: string | null;
  /** 0–100 progress bar (Plan), or null to omit. */
  bar?: number | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Open ${label}`}
      className="group flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-zinc-800/60"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 flex-shrink-0 text-zinc-500" />
        <span className="flex-1 text-xs text-zinc-400">{label}</span>
        {sub && <span className="text-[10px] tabular-nums text-emerald-400/80">{sub}</span>}
        <span className="text-xs font-medium tabular-nums text-zinc-100">{value}</span>
        <ChevronRight className="w-3 h-3 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      {bar != null && (
        <div className="ml-[22px] h-1 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${bar}%` }} />
        </div>
      )}
    </button>
  );
}

/**
 * Minimized ViewBoard — a purpose-built at-a-glance summary, NOT the full board shrunk.
 * One row per board with its key signal (plan progress, token/cost total, live session
 * count, recent approvals); clicking a row expands the full panel straight to that board.
 * Reads the same resource verbs the boards do (channel-wide, all sessions).
 */
export function ViewBoardMinimized({
  ctx,
  onExpand,
}: {
  ctx: ViewBoardContext;
  onExpand: (boardId: string) => void;
}) {
  const [s, setS] = useState<Summary>({
    plan: null,
    cost: null,
    sessions: null,
    approvals: null,
    activity: null,
  });

  // Guard against a stale channel's response landing after a switch: each loader
  // captures the channel it fetched for and only commits if it's still current.
  const cidRef = useRef(ctx.channelId);
  cidRef.current = ctx.channelId;

  const loadPlan = useCallback(() => {
    const cid = ctx.channelId;
    ctx
      .sendResourceReq("channel.plan.read", { channel_id: cid })
      .then((r) => {
        if (cidRef.current !== cid) return;
        const ps = (r as { plans?: { completed?: number; total?: number }[] }).plans ?? [];
        setS((p) => ({
          ...p,
          plan: {
            completed: ps.reduce((a, x) => a + (x.completed || 0), 0),
            total: ps.reduce((a, x) => a + (x.total || 0), 0),
          },
        }));
      })
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, plan: null })));
  }, [ctx.channelId, ctx.sendResourceReq]);

  const loadCost = useCallback(() => {
    const cid = ctx.channelId;
    ctx
      .sendResourceReq("channel.usage.read", { channel_id: cid })
      .then((r) => {
        if (cidRef.current !== cid) return;
        const bs = (r as { bots?: { total_tokens?: number; cost_usd?: number }[] }).bots ?? [];
        setS((p) => ({
          ...p,
          cost: {
            tokens: bs.reduce((a, x) => a + (x.total_tokens || 0), 0),
            cost: bs.reduce((a, x) => a + (x.cost_usd || 0), 0),
          },
        }));
      })
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, cost: null })));
  }, [ctx.channelId, ctx.sendResourceReq]);

  const loadSessions = useCallback(() => {
    const cid = ctx.channelId;
    ctx
      .sendResourceReq("channel.sessions.read", { channel_id: cid })
      .then((r) => {
        if (cidRef.current !== cid) return;
        setS((p) => ({ ...p, sessions: ((r as { sessions?: unknown[] }).sessions ?? []).length }));
      })
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, sessions: null })));
  }, [ctx.channelId, ctx.sendResourceReq]);

  const loadApprovals = useCallback(() => {
    const cid = ctx.channelId;
    listApprovalAudit(cid)
      .then(
        (r) =>
          cidRef.current === cid && setS((p) => ({ ...p, approvals: (r.events ?? []).length }))
      )
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, approvals: null })));
  }, [ctx.channelId]);

  const loadActivity = useCallback(() => {
    const cid = ctx.channelId;
    ctx
      .sendResourceReq("channel.activity.read", {
        channel_id: cid,
        limit: ACTIVITY_WINDOW,
        desc: true,
      })
      .then((r) => {
        if (cidRef.current !== cid) return;
        const evs =
          (r as { events?: { data?: { sender_id?: string } }[] }).events ?? [];
        const members = new Set(evs.map((e) => e.data?.sender_id).filter(Boolean));
        setS((p) => ({ ...p, activity: { events: evs.length, members: members.size } }));
      })
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, activity: null })));
  }, [ctx.channelId, ctx.sendResourceReq]);

  // Targeted live-push: each summary re-reads only on ITS signal (plus mount /
  // channel change, when the loader identity changes) — not on every board tick.
  const planTick = ctx.boardTick?.plan ?? 0;
  useEffect(() => loadPlan(), [planTick, loadPlan]);
  const costTick = ctx.boardTick?.cost ?? 0;
  useEffect(() => loadCost(), [costTick, loadCost]);
  const sessionsTick = ctx.boardTick?.sessions ?? 0;
  useEffect(() => loadSessions(), [sessionsTick, loadSessions]);
  const auditTick = ctx.boardTick?.audit ?? 0;
  useEffect(() => loadApprovals(), [auditTick, loadApprovals]);
  const activityTick = ctx.boardTick?.activity ?? 0;

  // Sessions have no dedicated signal — they change with agent activity, so refresh
  // them (and the activity glance itself) on the per-message "activity" tick,
  // debounced so a burst of messages collapses into one read. Skips the mount
  // (the loader-identity effects already load everything once).
  const lastActivity = useRef(activityTick);
  useEffect(() => {
    if (activityTick === lastActivity.current) return;
    lastActivity.current = activityTick;
    const t = setTimeout(() => {
      loadSessions();
      loadActivity();
    }, 800);
    return () => clearTimeout(t);
  }, [activityTick, loadSessions, loadActivity]);
  useEffect(() => loadActivity(), [loadActivity]);

  const pct = s.plan && s.plan.total > 0 ? Math.round((s.plan.completed / s.plan.total) * 100) : 0;

  return (
    <div className="p-1.5">
      <GlanceRow
        Icon={ClipboardList}
        label="Plan"
        value={s.plan ? `${s.plan.completed}/${s.plan.total}` : "—"}
        bar={s.plan && s.plan.total > 0 ? pct : null}
        onClick={() => onExpand("plan")}
      />
      <GlanceRow
        Icon={Coins}
        label="Cost"
        // Prefer $ cost (the headline metric); fall back to token total, then "—".
        value={
          s.cost && s.cost.cost
            ? fmtUsd(s.cost.cost)
            : s.cost && s.cost.tokens
              ? `${fmtTokens(s.cost.tokens)} tok`
              : "—"
        }
        sub={s.cost && s.cost.cost && s.cost.tokens ? `${fmtTokens(s.cost.tokens)} tok` : null}
        onClick={() => onExpand("cost")}
      />
      <GlanceRow
        Icon={Layers}
        label="Sessions"
        value={s.sessions != null ? String(s.sessions) : "—"}
        onClick={() => onExpand("sessions")}
      />
      <GlanceRow
        Icon={ShieldCheck}
        label="Approvals"
        value={s.approvals != null ? String(s.approvals) : "—"}
        onClick={() => onExpand("audit")}
      />
      <GlanceRow
        Icon={Activity}
        label="Activity"
        // Windowed read — a full window means "at least this many" recent events.
        value={
          s.activity
            ? s.activity.events >= ACTIVITY_WINDOW
              ? `${ACTIVITY_WINDOW}+`
              : String(s.activity.events)
            : "—"
        }
        sub={
          s.activity && s.activity.members > 0
            ? `${s.activity.members} member${s.activity.members > 1 ? "s" : ""}`
            : null
        }
        onClick={() => onExpand("activity")}
      />
    </div>
  );
}
