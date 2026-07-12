import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ClipboardList, Coins, Layers, ShieldCheck } from "lucide-react";
import { listApprovalAudit, type AuditEvent } from "@/api/approval";
import { GlanceRow, DetailLine } from "@/components/ui/glance-row";
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
function fmtAgo(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

// Lite shapes of the boards' reads — only what the glance needs.
interface PlanLite {
  session_id?: string | null;
  total?: number;
  completed?: number;
}
interface UsageLite {
  bot_id: string;
  total_tokens?: number | null;
  cost_usd?: number | null;
}
interface SessionLite {
  session_id: string;
  bot_id: string;
  bot_name?: string | null;
  is_primary?: boolean;
  status?: string;
}
interface LatestActivity {
  sender_id?: string;
  created_at?: string | null;
  preview?: string;
}

interface Summary {
  plans: PlanLite[] | null;
  usage: UsageLite[] | null;
  sessions: SessionLite[] | null;
  audit: AuditEvent[] | null;
  latest: LatestActivity | null;
  /** member_id → display label, for naming bots/users in the glance. */
  names: Record<string, string> | null;
}

// channel.activity.read is windowed; only the newest event feeds the glance.
const ACTIVITY_WINDOW = 1;

// Same decision classification the Audit board uses (AuditPanel.meta), reduced to counts.
function classifyAudit(e: AuditEvent): "allowed" | "denied" | "expired" | "pending" {
  const d = (e.decision ?? "").toLowerCase();
  const et = (e.event_type ?? "").toLowerCase();
  if (d.startsWith("allow") || et.includes("allow")) return "allowed";
  if (d.startsWith("reject") || d.startsWith("deny") || et.includes("reject") || et.includes("deny"))
    return "denied";
  if (et.includes("expire")) return "expired";
  return "pending";
}

/**
 * Minimized ViewBoard — a purpose-built at-a-glance summary, NOT the full board shrunk.
 * One row per board with its key signal: the PRIMARY sessions' plan progress, total cost
 * with a per-bot breakdown, a session count + status summary, a permission decision
 * summary, and the latest activity event. Clicking a row expands the full panel straight
 * to that board. Reads the same resource verbs the boards do (channel-wide).
 */
export function ViewBoardMinimized({
  ctx,
  onExpand,
}: {
  ctx: ViewBoardContext;
  onExpand: (boardId: string) => void;
}) {
  const [s, setS] = useState<Summary>({
    plans: null,
    usage: null,
    sessions: null,
    audit: null,
    latest: null,
    names: null,
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
        setS((p) => ({ ...p, plans: (r as { plans?: PlanLite[] }).plans ?? [] }));
      })
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, plans: null })));
  }, [ctx.channelId, ctx.sendResourceReq]);

  const loadCost = useCallback(() => {
    const cid = ctx.channelId;
    ctx
      .sendResourceReq("channel.usage.read", { channel_id: cid })
      .then((r) => {
        if (cidRef.current !== cid) return;
        setS((p) => ({ ...p, usage: (r as { bots?: UsageLite[] }).bots ?? [] }));
      })
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, usage: null })));
  }, [ctx.channelId, ctx.sendResourceReq]);

  const loadSessions = useCallback(() => {
    const cid = ctx.channelId;
    ctx
      .sendResourceReq("channel.sessions.read", { channel_id: cid })
      .then((r) => {
        if (cidRef.current !== cid) return;
        setS((p) => ({ ...p, sessions: (r as { sessions?: SessionLite[] }).sessions ?? [] }));
      })
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, sessions: null })));
  }, [ctx.channelId, ctx.sendResourceReq]);

  const loadAudit = useCallback(() => {
    const cid = ctx.channelId;
    listApprovalAudit(cid)
      .then((r) => cidRef.current === cid && setS((p) => ({ ...p, audit: r.events ?? [] })))
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, audit: null })));
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
        const ev = (
          (r as {
            events?: {
              created_at?: string | null;
              data?: { sender_id?: string; content?: string; created_at?: string };
            }[];
          }).events ?? []
        )[0];
        setS((p) => ({
          ...p,
          latest: ev
            ? {
                sender_id: ev.data?.sender_id,
                created_at: ev.created_at ?? ev.data?.created_at ?? null,
                // Agent-authored content: rendered as inert, truncated text only.
                preview: (ev.data?.content ?? "").slice(0, 80),
              }
            : null,
        }));
      })
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, latest: null })));
  }, [ctx.channelId, ctx.sendResourceReq]);

  const loadNames = useCallback(() => {
    const cid = ctx.channelId;
    ctx
      .sendResourceReq("channel.members", { channel_id: cid })
      .then((r) => {
        if (cidRef.current !== cid) return;
        const names: Record<string, string> = {};
        for (const m of (
          r as { members?: { member_id: string; display_name?: string | null; username?: string | null }[] }
        ).members ?? []) {
          names[m.member_id] = m.display_name || m.username || m.member_id.slice(0, 8);
        }
        setS((p) => ({ ...p, names }));
      })
      .catch(() => cidRef.current === cid && setS((p) => ({ ...p, names: null })));
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
  useEffect(() => loadAudit(), [auditTick, loadAudit]);
  useEffect(() => loadActivity(), [loadActivity]);
  useEffect(() => loadNames(), [loadNames]);
  const activityTick = ctx.boardTick?.activity ?? 0;

  // Sessions have no dedicated signal — they change with agent activity, so refresh
  // them (and the latest-activity line) on the per-message "activity" tick, debounced
  // so a burst of messages collapses into one read. Skips the mount (the
  // loader-identity effects already load everything once).
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

  const label = (id?: string | null) => (id ? (s.names?.[id] ?? id.slice(0, 8)) : "—");

  // ── Plan: the PRIMARY sessions' plans (fall back to all plans when none match). ──
  const primaryIds = new Set((s.sessions ?? []).filter((x) => x.is_primary).map((x) => x.session_id));
  const primaryPlans = (s.plans ?? []).filter((p) => p.session_id && primaryIds.has(p.session_id));
  const planScope = primaryPlans.length ? primaryPlans : (s.plans ?? []);
  const planDone = planScope.reduce((a, p) => a + (p.completed || 0), 0);
  const planTotal = planScope.reduce((a, p) => a + (p.total || 0), 0);
  const planPct = planTotal > 0 ? Math.round((planDone / planTotal) * 100) : 0;

  // ── Cost: channel total + per-bot breakdown (usage rows are per (bot, session)). ──
  const byBot = new Map<string, { tokens: number; cost: number }>();
  for (const u of s.usage ?? []) {
    const cur = byBot.get(u.bot_id) ?? { tokens: 0, cost: 0 };
    cur.tokens += u.total_tokens || 0;
    cur.cost += u.cost_usd || 0;
    byBot.set(u.bot_id, cur);
  }
  const botCosts = [...byBot.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const totalCost = botCosts.reduce((a, [, v]) => a + v.cost, 0);
  const totalTokens = botCosts.reduce((a, [, v]) => a + v.tokens, 0);
  const COST_LINES = 4;

  // ── Sessions: count + status breakdown ("1 busy · 2 idle"). ──
  const byStatus = new Map<string, number>();
  for (const x of s.sessions ?? []) {
    const st = x.status || "unknown";
    byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
  }
  const sessionSummary = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([st, n]) => `${n} ${st}`)
    .join(" · ");

  // ── Approvals: decision summary with the Audit board's classification. ──
  const audit = { allowed: 0, denied: 0, expired: 0, pending: 0 };
  for (const e of s.audit ?? []) audit[classifyAudit(e)]++;
  const permissionSummary = [
    audit.allowed ? `${audit.allowed} allowed` : null,
    audit.denied ? `${audit.denied} denied` : null,
    audit.pending ? `${audit.pending} pending` : null,
    audit.expired ? `${audit.expired} expired` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="p-1.5">
      <GlanceRow
        Icon={ClipboardList}
        label="Plan"
        sub={primaryPlans.length ? "primary" : planScope.length ? "all" : null}
        value={s.plans ? `${planDone}/${planTotal}` : "—"}
        bar={planTotal > 0 ? planPct : null}
        onClick={() => onExpand("plan")}
      />
      <GlanceRow
        Icon={Coins}
        label="Cost"
        // Prefer $ cost (the headline metric); fall back to token total, then "—".
        value={
          s.usage
            ? totalCost
              ? fmtUsd(totalCost)
              : totalTokens
                ? `${fmtTokens(totalTokens)} tok`
                : "—"
            : "—"
        }
        onClick={() => onExpand("cost")}
      >
        {botCosts.slice(0, COST_LINES).map(([botId, v]) => (
          <DetailLine
            key={botId}
            name={label(botId)}
            figure={v.cost ? fmtUsd(v.cost) : `${fmtTokens(v.tokens)} tok`}
          />
        ))}
        {botCosts.length > COST_LINES && (
          <DetailLine name={`+${botCosts.length - COST_LINES} more`} />
        )}
      </GlanceRow>
      <GlanceRow
        Icon={Layers}
        label="Sessions"
        value={s.sessions ? String(s.sessions.length) : "—"}
        onClick={() => onExpand("sessions")}
      >
        {sessionSummary && <DetailLine name={sessionSummary} />}
      </GlanceRow>
      <GlanceRow
        Icon={ShieldCheck}
        label="Approvals"
        value={s.audit ? String(s.audit.length) : "—"}
        onClick={() => onExpand("audit")}
      >
        {permissionSummary && <DetailLine name={permissionSummary} />}
      </GlanceRow>
      <GlanceRow
        Icon={Activity}
        label="Activity"
        value={s.latest ? fmtAgo(s.latest.created_at) : "—"}
        onClick={() => onExpand("activity")}
      >
        {s.latest && (
          <DetailLine
            name={
              s.latest.preview
                ? `${label(s.latest.sender_id)}: ${s.latest.preview}`
                : label(s.latest.sender_id)
            }
          />
        )}
      </GlanceRow>
    </div>
  );
}
