// Audit — a ViewBoard focused on the channel's permission/approval decisions
// (replaces the old generic Activity feed). Sourced from the REST audit log
// (listApprovalAudit → /channels/{id}/permissions/audit), latest-first, plus
// the channel roster (listChannelMembers → id -> name + avatar_url) so "who
// approved" and "which bot" read as avatars, not raw uuids. Self-fetching (no
// resource verb): re-fetches on the "audit" board tick, which ChannelView bumps
// when a permission resolves. All ids/values render as inert text.
//
// Each row is a card whose LEFT EDGE encodes the outcome (emerald = approved,
// rose = denied, amber = pending, zinc = timed out). The headline is the
// concrete thing being approved (the tool command / file), NOT the generic
// "ACP permission request" title the connector hard-codes — that content lives
// nested in `detail.tool`, which we dig into here. A "Details" toggle expands
// the full choice (decision + option) and tool detail (command / paths / cwd).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ShieldCheck, Check, X, Clock, ShieldQuestion, ChevronRight } from "lucide-react";
import { listApprovalAudit, type AuditEvent } from "@/api/approval";
import { listChannelMembers } from "@/api/channels";
import type { MemberItem } from "@/types";
import { Avatar } from "@/components/ui/avatar";
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

// ── detail extraction ───────────────────────────────────────────────────────
// The gateway stores audit `detail` as `{ title, tool }` where `title` is the
// connector's generic "ACP permission request" and `tool` is the structured
// descriptor (command / raw_input / locations / cwd / kind). The real content
// is one level down in `tool`, so we dig into it rather than reading the title.

function toolOf(detail: unknown): Record<string, unknown> | null {
  if (detail && typeof detail === "object") {
    const t = (detail as Record<string, unknown>).tool;
    if (t && typeof t === "object") return t as Record<string, unknown>;
  }
  return null;
}

const str = (o: Record<string, unknown> | null, k: string): string | null =>
  o && typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null;

function rawInputOf(tool: Record<string, unknown> | null): Record<string, unknown> | null {
  const ri = tool?.raw_input;
  return ri && typeof ri === "object" ? (ri as Record<string, unknown>) : null;
}

/** The file paths this tool touches (ACP `locations`, or raw_input's file_path). */
function locationPaths(tool: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const locs = tool?.locations;
  if (Array.isArray(locs)) {
    for (const l of locs) {
      if (typeof l === "string") out.push(l);
      else if (l && typeof l === "object" && typeof (l as Record<string, unknown>).path === "string")
        out.push((l as Record<string, unknown>).path as string);
    }
  }
  const ri = rawInputOf(tool);
  for (const k of ["file_path", "path"]) {
    const v = str(ri, k);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The single most concrete line describing WHAT is being approved. */
function contentLine(detail: unknown): string | null {
  const tool = toolOf(detail);
  if (tool) {
    const ri = rawInputOf(tool);
    return (
      str(tool, "command") ||
      str(ri, "command") ||
      str(ri, "file_path") ||
      str(ri, "path") ||
      str(tool, "title") ||
      locationPaths(tool)[0] ||
      null
    );
  }
  // Legacy / non-ACP details: accept concrete top-level keys, but never the
  // generic `title` (that's the hard-coded "ACP permission request").
  if (detail && typeof detail === "object") {
    const o = detail as Record<string, unknown>;
    for (const k of ["command", "file_path", "path", "body"]) {
      const v = str(o, k);
      if (v) return v;
    }
  }
  if (typeof detail === "string") return detail;
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

type Tone = {
  Icon: typeof Check;
  text: string; // text/icon color for the status chip
  border: string; // LEFT-edge color: emerald=approved, rose=denied, amber=pending, zinc=done
  label: string;
  raw: string;
};

// Decision/event → icon + tone + Cheers label + card edge. Accept reads emerald
// (green edge), deny/reject reads rose (red edge), timeout muted zinc, a bare
// request (no decision yet) gets the amber shield.
function tone(e: AuditEvent): Tone {
  const d = (e.decision ?? "").toLowerCase();
  const et = (e.event_type ?? "").toLowerCase();
  const raw = [e.event_type, e.decision].filter(Boolean).join(" · ");
  if (d.startsWith("allow") || et.includes("allow") || et === "access_granted")
    return {
      Icon: Check,
      text: "text-emerald-400",
      border: "border-l-emerald-500",
      label: (e.decision && (DECISION_LABEL[d] ?? humanize(e.decision))) || "Approved",
      raw,
    };
  if (d.startsWith("reject") || d.startsWith("deny") || et.includes("reject") || et.includes("deny") || et === "access_revoked")
    return {
      Icon: X,
      text: "text-red-400",
      border: "border-l-red-500",
      label: (e.decision && (DECISION_LABEL[d] ?? humanize(e.decision))) || "Denied",
      raw,
    };
  if (et.includes("expire") || et === "timeout")
    return {
      Icon: Clock,
      text: "text-zinc-400",
      border: "border-l-zinc-600",
      label: EVENT_TYPE_LABEL[et] ?? "Expired",
      raw,
    };
  return {
    Icon: ShieldQuestion,
    text: "text-amber-400",
    border: "border-l-amber-500",
    label: e.event_type ? EVENT_TYPE_LABEL[et] ?? humanize(e.event_type) : "Request",
    raw,
  };
}

type MemberLookup = (id?: string | null) => MemberItem | undefined;

/** A compact avatar + name chip. Falls back to the short id when the member is
 *  no longer in the roster (left the channel, deleted bot). */
function MemberChip({ id, member }: { id?: string | null; member?: MemberItem }) {
  if (!id) return null;
  const name = member?.display_name || member?.username || short(id);
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <Avatar name={name} src={member?.avatar_url ?? undefined} id={id} size="xs" className="!w-4 !h-4 !text-[8px]" />
      <span className="truncate text-zinc-400">{name}</span>
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-[10px] uppercase tracking-wide text-zinc-600 w-14 flex-shrink-0 pt-px">{label}</span>
      <span className="min-w-0 flex-1 text-[11px] text-zinc-400 break-words">{children}</span>
    </div>
  );
}

function AuditRow({
  e,
  memberOf,
  onJump,
}: {
  e: AuditEvent;
  memberOf: MemberLookup;
  onJump?: (msgId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const t = tone(e);
  const content = contentLine(e.detail);
  const tool = toolOf(e.detail);
  const paths = locationPaths(tool);
  const command = str(tool, "command") || str(rawInputOf(tool), "command");
  const cwd = str(tool, "cwd");
  const kind = str(tool, "kind");
  const toolTitle = str(tool, "title");
  const decisionLabel = e.decision ? DECISION_LABEL[e.decision.toLowerCase()] ?? humanize(e.decision) : null;

  const bot = memberOf(e.bot_id);
  const approver = memberOf(e.actor_id);
  const target =
    e.target_user_id && e.target_user_id !== e.actor_id ? memberOf(e.target_user_id) : undefined;

  // Only offer Details when there's something more to show than the headline.
  const hasDetails = Boolean(
    command || paths.length || cwd || kind || e.option_id || (content && content.length > 60)
  );

  return (
    <li className={`border-l-2 ${t.border} bg-zinc-900/30 rounded-r-md mb-1.5`}>
      <div className="px-3 py-2">
        {/* Headline: the concrete thing being approved + which bot + when. */}
        <div className="flex items-start gap-2">
          {e.bot_id && (
            <Avatar
              name={bot?.display_name || bot?.username || short(e.bot_id)}
              src={bot?.avatar_url ?? undefined}
              id={e.bot_id}
              size="xs"
              className="mt-px !w-5 !h-5 !text-[9px]"
            />
          )}
          <div className="min-w-0 flex-1">
            {/* Headline: clickable when the audit event anchors to a channel
                message (jump is best-effort — resolved permission cards are
                folded out of the list, so the jump may just toast). */}
            {e.msg_id && onJump ? (
              <button
                type="button"
                onClick={() => onJump(e.msg_id!)}
                title="Jump to this message"
                className="block w-full text-left text-xs text-zinc-200 font-medium leading-snug break-words hover:text-indigo-300 transition-colors"
              >
                {content || t.label}
              </button>
            ) : (
              <div className="text-xs text-zinc-200 font-medium leading-snug break-words">
                {content || t.label}
              </div>
            )}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span
                className={`inline-flex items-center gap-1 text-[11px] font-medium ${t.text}`}
                title={t.raw || undefined}
              >
                <t.Icon className="w-3 h-3" />
                {t.label}
              </span>
              {e.actor_id && (
                <>
                  <span className="text-zinc-700">·</span>
                  <MemberChip id={e.actor_id} member={approver} />
                </>
              )}
              {target && (
                <>
                  <span className="text-[10px] text-zinc-600">for</span>
                  <MemberChip id={e.target_user_id} member={target} />
                </>
              )}
            </div>
          </div>
          <span className="text-[10px] text-zinc-600 tabular-nums whitespace-nowrap mt-px">
            {fmtTime(e.created_at)}
          </span>
        </div>

        {hasDetails && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1.5 inline-flex items-center gap-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
            Details
          </button>
        )}

        {open && (
          <div className="mt-1.5 space-y-1 rounded bg-zinc-950/50 px-2.5 py-2 ">
            {decisionLabel && (
              <DetailRow label="Choice">
                <span className={t.text}>{decisionLabel}</span>
                {e.option_id && <span className="text-zinc-600 font-mono"> · {e.option_id}</span>}
              </DetailRow>
            )}
            {toolTitle && !command && (
              <DetailRow label="Tool">
                <span className="font-mono">{toolTitle}</span>
              </DetailRow>
            )}
            {command && (
              <DetailRow label="Command">
                <span className="font-mono text-zinc-300 whitespace-pre-wrap">{command}</span>
              </DetailRow>
            )}
            {paths.length > 0 && (
              <DetailRow label={paths.length > 1 ? "Files" : "File"}>
                <span className="font-mono">{paths.join(", ")}</span>
              </DetailRow>
            )}
            {cwd && (
              <DetailRow label="cwd">
                <span className="font-mono">{cwd}</span>
              </DetailRow>
            )}
            {kind && <DetailRow label="Kind">{kind}</DetailRow>}
            {e.request_id && (
              <DetailRow label="Request">
                <span className="font-mono text-zinc-600">{short(e.request_id)}</span>
              </DetailRow>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function AuditBody({ ctx }: { ctx: ViewBoardContext }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [auditRes, membersRes] = await Promise.allSettled([
      listApprovalAudit(ctx.channelId),
      listChannelMembers(ctx.channelId),
    ]);
    setEvents(auditRes.status === "fulfilled" ? auditRes.value.events ?? [] : []);
    if (membersRes.status === "fulfilled") setMembers(membersRes.value ?? []);
    setLoading(false);
  }, [ctx.channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-push: ChannelView bumps the "audit" tick when a permission resolves.
  // Deferred while the board is kept-alive but hidden; catches up on reveal.
  useBoardTickRefetch(ctx, "audit", load);

  const byId = useMemo(() => {
    const m = new Map<string, MemberItem>();
    for (const mem of members) m.set(mem.member_id, mem);
    return m;
  }, [members]);
  const memberOf: MemberLookup = useCallback((id) => (id ? byId.get(id) : undefined), [byId]);

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
        <ul className="px-2 py-2">
          {events.map((e, i) => (
            <AuditRow
              key={`${e.request_id ?? e.event_type}-${e.created_at}-${i}`}
              e={e}
              memberOf={memberOf}
              onJump={ctx.onJumpToMessage}
            />
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
