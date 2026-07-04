// Audit — a ViewBoard focused on the channel's permission/approval decisions
// (replaces the old generic Activity feed). Sourced from the REST audit log
// (listApprovalAudit → /channels/{id}/permissions/audit), latest-first. Self-fetching
// (no resource verb): re-fetches on the "audit" board tick, which ChannelView bumps when
// a permission resolves. All ids/values render as inert text.
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Check, X, Clock, ShieldQuestion } from "lucide-react";
import { listApprovalAudit, type AuditEvent } from "@/api/approval";
import {
  registerComponentViewBoard,
  useBoardTickRefetch,
  ViewBoardShell,
  type ViewBoardContext,
} from "../viewBoard";

function fmtTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function short(id: unknown): string {
  return typeof id === "string" ? id.slice(0, 8) : "";
}

/** Pull a short human summary (command / file / title) out of the opaque detail blob. */
function detailSummary(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === "string") return detail;
  if (typeof detail === "object") {
    const o = detail as Record<string, unknown>;
    for (const k of ["command", "title", "tool", "file_path", "path", "body"]) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
  }
  return null;
}

// Cheers-facing headlines for the raw ids the backend records: ACP permission
// option kinds (decision) and audit event types. Raw ids stay in the tooltip.
const DECISION_LABEL: Record<string, string> = {
  allow_once: "Approved once",
  allow_always: "Always approved",
  reject_once: "Denied once",
  reject_always: "Always denied",
};
const EVENT_TYPE_LABEL: Record<string, string> = {
  requested: "Approval requested",
  resolved: "Resolved",
  access_requested: "Access requested",
  access_granted: "Access granted",
  access_revoked: "Access revoked",
  timeout: "Timed out",
};
/** Last-resort humanizer so an unmapped id never headlines as snake_case. */
const humanize = (id: string) => id.replaceAll("_", " ");

// Decision/event → icon + tone + Cheers label. Allow reads quiet, deny/reject reads
// rose, expired/timeout muted, a bare request (no decision yet) gets the amber shield.
function meta(e: AuditEvent): { Icon: typeof Check; tone: string; label: string; raw: string } {
  const d = (e.decision ?? "").toLowerCase();
  const et = (e.event_type ?? "").toLowerCase();
  const raw = [e.event_type, e.decision].filter(Boolean).join(" · ");
  if (d.startsWith("allow") || et.includes("allow"))
    return {
      Icon: Check,
      tone: "text-emerald-500/80",
      label: (e.decision && (DECISION_LABEL[d] ?? humanize(e.decision))) || "Approved",
      raw,
    };
  if (d.startsWith("reject") || d.startsWith("deny") || et.includes("reject") || et.includes("deny"))
    return {
      Icon: X,
      tone: "text-rose-400/80",
      label: (e.decision && (DECISION_LABEL[d] ?? humanize(e.decision))) || "Denied",
      raw,
    };
  if (et.includes("expire") || et === "timeout")
    return { Icon: Clock, tone: "text-zinc-500", label: EVENT_TYPE_LABEL[et] ?? "Expired", raw };
  return {
    Icon: ShieldQuestion,
    tone: "text-amber-400/70",
    label: e.event_type ? EVENT_TYPE_LABEL[et] ?? humanize(e.event_type) : "Request",
    raw,
  };
}

function AuditRow({ e }: { e: AuditEvent }) {
  const { Icon, tone, label, raw } = meta(e);
  const summary = detailSummary(e.detail);
  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${tone}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`text-xs font-medium ${tone}`} title={raw || undefined}>{label}</span>
            {e.bot_id && <span className="text-[10px] text-zinc-500 font-mono">bot {short(e.bot_id)}</span>}
            <div className="flex-1" />
            <span className="text-[10px] text-zinc-600 tabular-nums whitespace-nowrap">{fmtTime(e.created_at)}</span>
          </div>
          {summary && <div className="text-[11px] font-mono text-zinc-500 truncate mt-0.5">{summary}</div>}
          {e.actor_id && (
            <div className="text-[10px] text-zinc-600 mt-0.5">by {short(e.actor_id)}</div>
          )}
        </div>
      </div>
    </li>
  );
}

function AuditBody({ ctx }: { ctx: ViewBoardContext }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listApprovalAudit(ctx.channelId);
      setEvents(res.events ?? []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [ctx.channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-push: ChannelView bumps the "audit" tick when a permission resolves.
  // Deferred while the board is kept-alive but hidden; catches up on reveal.
  useBoardTickRefetch(ctx, "audit", load);

  return (
    <ViewBoardShell title="Audit" icon={ShieldCheck} loading={loading} onRefresh={() => void load()}>
      {events == null ? (
        <div className="px-3 py-6 text-xs text-zinc-600">Loading…</div>
      ) : events.length === 0 ? (
        <div className="px-3 py-6 text-xs text-zinc-600 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          No permission decisions yet
        </div>
      ) : (
        <ul className="text-xs divide-y divide-zinc-900">
          {events.map((e, i) => (
            <AuditRow key={`${e.request_id ?? e.event_type}-${e.created_at}-${i}`} e={e} />
          ))}
        </ul>
      )}
    </ViewBoardShell>
  );
}

registerComponentViewBoard({
  id: "audit",
  title: "Audit",
  icon: ShieldCheck,
  component: (ctx) => <AuditBody ctx={ctx} />,
});
