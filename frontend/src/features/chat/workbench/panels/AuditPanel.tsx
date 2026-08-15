import { Button as UiButton } from "@/components/ui/button";
// Audit — a ViewBoard focused on the channel's permission/approval decisions
// (replaces the old generic Activity feed). Sourced from the REST audit log
// (listApprovalAudit → /channels/{id}/permissions/audit), latest-first, plus
// the channel roster (listChannelMembers → id -> name + avatar_url) so "who
// approved" and "which bot" read as avatars, not raw uuids. Self-fetching (no
// resource verb): re-fetches on the "audit" board tick, which ChannelView bumps
// when a permission resolves. All ids/values render as inert text.
//
// Each row is a compact timeline record. Its outcome icon is the sole color
// signal; the headline is the concrete command/file, never the connector's
// generic "ACP permission request". The drawer owns expansion, so only one
// record reveals its raw choice and tool detail at a time.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ShieldCheck, Check, X, Clock, ShieldQuestion, ChevronRight, MessageSquareText } from "lucide-react";
import { listApprovalAudit, type AuditEvent } from "@/api/approval";
import { listChannelMembers } from "@/api/channels";
import type { MemberItem } from "@/types";
import { Avatar } from "@/components/ui/avatar";
import { WorkbenchItem } from "@/components/ui/item";
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

/** Connector fallbacks such as "ACP permission request" describe the protocol,
 * not the operation. They must never occupy an audit row's scarce title slot. */
function concreteText(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "acp permission request" || normalized === "permission request" || normalized === "approval request"
    ? null
    : value;
}

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
      concreteText(str(tool, "summary")) ||
      str(tool, "command") ||
      str(ri, "command") ||
      str(ri, "file_path") ||
      str(ri, "path") ||
      concreteText(str(tool, "title")) ||
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
  text: string;
  label: string;
  raw: string;
};

// Decision/event → one semantic outcome icon and a concise label. The list does
// not repeat that signal as an avatar, card edge, and colored text at once.
function tone(e: AuditEvent): Tone {
  const d = (e.decision ?? "").toLowerCase();
  const et = (e.event_type ?? "").toLowerCase();
  const raw = [e.event_type, e.decision].filter(Boolean).join(" · ");
  if (d.startsWith("allow") || et.includes("allow") || et === "access_granted")
    return {
      Icon: Check,
      text: "text-success-400",
      label: (e.decision && (DECISION_LABEL[d] ?? humanize(e.decision))) || "Approved",
      raw,
    };
  if (d.startsWith("reject") || d.startsWith("deny") || et.includes("reject") || et.includes("deny") || et === "access_revoked")
    return {
      Icon: X,
      text: "text-danger-400",
      label: (e.decision && (DECISION_LABEL[d] ?? humanize(e.decision))) || "Denied",
      raw,
    };
  if (et.includes("expire") || et === "timeout")
    return {
      Icon: Clock,
      text: "text-content-muted",
      label: EVENT_TYPE_LABEL[et] ?? "Expired",
      raw,
    };
  return {
    Icon: ShieldQuestion,
    text: "text-warning-400",
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
      <Avatar name={name} src={member?.avatar_url ?? undefined} id={id} size="small" />
      <span className="truncate text-content-muted">{name}</span>
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-minimal uppercase tracking-label text-content-muted w-14 flex-shrink-0 pt-px">{label}</span>
      <span className="min-w-0 flex-1 text-compact text-content-muted break-words">{children}</span>
    </div>
  );
}

function AuditRow({
  e,
  memberOf,
  onJump,
  open,
  onToggleDetails,
}: {
  e: AuditEvent;
  memberOf: MemberLookup;
  onJump?: (msgId: string, requestId?: string | null) => void;
  open: boolean;
  onToggleDetails: () => void;
}) {
  const t = tone(e);
  const content = contentLine(e.detail);
  const tool = toolOf(e.detail);
  const paths = locationPaths(tool);
  const command = str(tool, "command") || str(rawInputOf(tool), "command");
  const cwd = str(tool, "cwd");
  const kind = str(tool, "kind");
  const toolTitle = concreteText(str(tool, "title"));
  const decisionLabel = e.decision ? DECISION_LABEL[e.decision.toLowerCase()] ?? humanize(e.decision) : null;

  const approver = memberOf(e.actor_id);
  const target =
    e.target_user_id && e.target_user_id !== e.actor_id ? memberOf(e.target_user_id) : undefined;

  // Only offer Details when there's something more to show than the headline.
  const hasDetails = Boolean(
    command || paths.length || cwd || kind || e.option_id || (content && content.length > 60)
  );

  return (
    <li className="mb-1 rounded-sm bg-zinc-900/30">
      <WorkbenchItem
        presentationLevel="medium"
        title={content || toolTitle || "Permission decision"}
        leading={<span className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center ${t.text}`} title={t.raw || undefined}>
          <t.Icon className="h-4 w-4" aria-label={t.label} />
        </span>}
        subtitle={<span className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className={`flex-shrink-0 font-medium ${t.text}`}>{t.label}</span>
          {e.actor_id && <MemberChip id={e.actor_id} member={approver} />}
          {target && <><span className="text-content-muted">·</span><MemberChip id={e.target_user_id} member={target} /></>}
        </span>}
        trailing={<span className="text-minimal tabular-nums whitespace-nowrap">{fmtTime(e.created_at)}</span>}
        actions={<>
          {e.msg_id && onJump && (
            <UiButton action="open" content="icon" variant="plain" type="button" aria-label="Jump to source message" title="Jump to source message" onClick={() => onJump(e.msg_id!, e.request_id)} className="text-content-primary hover:text-accent-300">
              <MessageSquareText className="h-3.5 w-3.5" />
            </UiButton>
          )}
          {hasDetails && (
          <UiButton action={open ? "collapse" : "expand"} content="icon" variant="plain"
            type="button"
            aria-label={open ? "Hide audit details" : "Show audit details"}
            title={open ? "Hide audit details" : "Show audit details"}
            aria-expanded={open}
            onClick={onToggleDetails}
            className="text-content-primary hover:text-content-strong"
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          </UiButton>
          )}
        </>}
        className="border-0 bg-transparent"
      />

        {open && (
          <div className="mx-3 mb-2 space-y-1 rounded-sm bg-zinc-950/50 px-3 py-2">
            {decisionLabel && (
              <DetailRow label="Choice">
                <span className={t.text}>{decisionLabel}</span>
                {e.option_id && <span className="text-content-muted font-code"> · {e.option_id}</span>}
              </DetailRow>
            )}
            {toolTitle && !command && (
              <DetailRow label="Tool">
                <span className="font-code">{toolTitle}</span>
              </DetailRow>
            )}
            {command && (
              <DetailRow label="Command">
                <span className="font-code text-content-secondary whitespace-pre-wrap">{command}</span>
              </DetailRow>
            )}
            {paths.length > 0 && (
              <DetailRow label={paths.length > 1 ? "Files" : "File"}>
                <span className="font-code">{paths.join(", ")}</span>
              </DetailRow>
            )}
            {cwd && (
              <DetailRow label="cwd">
                <span className="font-code">{cwd}</span>
              </DetailRow>
            )}
            {kind && <DetailRow label="Kind">{kind}</DetailRow>}
            {e.request_id && (
              <DetailRow label="Request">
                <span className="font-code text-content-muted">{short(e.request_id)}</span>
              </DetailRow>
            )}
          </div>
        )}
    </li>
  );
}

function AuditBody({ ctx }: { ctx: ViewBoardContext }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [openEventKey, setOpenEventKey] = useState<string | null>(null);

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
        <div className="px-3 py-6 text-compact text-content-muted">Loading…</div>
      ) : events.length === 0 ? (
        <div className="px-3 py-6 text-compact text-content-muted flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          No permission decisions yet
        </div>
      ) : (
        <ul className="px-2 py-2" aria-label="Permission audit log">
          {events.map((e, i) => {
            const eventKey = `${e.request_id ?? e.event_type}-${e.created_at}-${i}`;
            return <AuditRow
              key={eventKey}
              e={e}
              memberOf={memberOf}
              onJump={ctx.onJumpToMessage}
              open={openEventKey === eventKey}
              onToggleDetails={() => setOpenEventKey((current) => current === eventKey ? null : eventKey)}
            />
          })}
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
