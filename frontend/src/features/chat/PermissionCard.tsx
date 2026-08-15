import { Button as UiButton } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/action-button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import {
  resolvePermission,
  requestApprovalAccess,
  listApprovers,
} from "@/api/approval";
import { getGitDiff } from "@/api/workspace";
import { useProfileCard } from "./ProfileHovercard";
import { DiffView } from "./DiffView";
import { looksLikeGitCommit } from "./workspaceLink";
import type { Message, PermissionContentData, PermissionOption } from "@/types";
import { OverflowText } from "@/components/ui/overflow-text";
import { ShieldCheck } from "lucide-react";

interface Props {
  message: Message;
  channelId?: string;
  currentUserId?: string;
  /** Server-authoritative may-answer flag (Fleet view passes the endpoint's
   *  `actionable`, which also covers RESPOND grants the card's own
   *  owner+delegate check can't see). When set, skips that self-check. */
  approverOverride?: boolean;
  /** Called after the gateway records a decision successfully. */
  onResolved?: () => void;
  /** Inline under an Agent steps row: always expanded, no collapse chrome. */
  embedded?: boolean;
  /** Message-inline approvals use the compact operational presentation. */
  compact?: boolean;
}

function optId(o: PermissionOption): string {
  return o.option_id ?? o.optionId ?? "";
}

function isAllow(kind?: string | null): boolean {
  return (kind ?? "").startsWith("allow");
}

/** Compact, human-readable preview of an ACP toolCall rawInput (the command /
 *  file path / content the agent wants to run). */
function previewRawInput(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const cmd = o.command ?? o.cmd;
    if (typeof cmd === "string") return cmd;
    const path = o.file_path ?? o.filePath ?? o.path;
    if (typeof path === "string") {
      const content = o.content ?? o.new_string ?? o.contents;
      return typeof content === "string"
        ? `${path}  (${content.length} chars)`
        : path;
    }
    try {
      const s = JSON.stringify(raw);
      return s.length > 300 ? `${s.slice(0, 300)}…` : s;
    } catch {
      return null;
    }
  }
  return String(raw);
}

/**
 * Interactive ACP approval box (docs/arch/ACP_APPROVAL_FLOW.md).
 *
 * Design (mockup: AgentNexus/docs/mockups/approve-menu.html): a quiet,
 * trace-styled menu — command-first, radio options, minimal footer. Anchored
 * cards render inside the bot turn's Agent steps (BotTracePanel); only orphans
 * without `source_msg_id` stay as their own channel row. While pending it shows
 * expanded (or a one-line collapsed preview); once resolved it shrinks into a
 * single trace-style line (or disappears from the channel when folded into the
 * durable approval trace row).
 */
export function PermissionCard({
  message,
  channelId,
  currentUserId,
  approverOverride,
  onResolved,
  embedded = false,
  compact = false,
}: Props) {
  const data = (message.content_data ?? {}) as PermissionContentData;
  const botId = message.sender_id;
  // Resolve "who approved" to a member name (falls back to the short id).
  const profileCard = useProfileCard();
  const resolverMember = data.resolved_by ? profileCard?.memberOf(data.resolved_by) : undefined;
  const resolverName =
    resolverMember?.display_name || resolverMember?.username || data.resolved_by?.slice(0, 8);
  const requestId = data.request_id ?? "";
  const options = useMemo(() => data.options ?? [], [data.options]);
  const resolved = data.resolved === true;

  const isOwner = !!currentUserId && currentUserId === data.bot_owner_id;
  const [amApprover, setAmApprover] = useState(
    approverOverride !== undefined ? approverOverride : isOwner
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  // Set when the resolve is recorded server-side but couldn't be delivered to the
  // agent (delivered:false) — e.g. the connector/session is offline. The card still
  // collapses to "✓ Approved"; without this the resolver would read that as "the
  // agent ran it", when in fact the agent may never receive the decision.
  const [undelivered, setUndelivered] = useState(false);
  // Pending starts expanded (the user must review); resolved settles collapsed.
  // Embedded (Agent steps) stays expanded until resolved.
  const [collapsed, setCollapsed] = useState(!!resolved);
  useEffect(() => {
    if (resolved) setCollapsed(true);
    else if (embedded) setCollapsed(false);
  }, [resolved, embedded]);

  // Read-side enrichment for `git commit` approvals: fetch + inline-preview the
  // staged diff so a human can see what the commit will actually include. This is
  // deliberately kept on its own state so it NEVER gates approve/deny resolution
  // (which watches only `busy`) — a failed or slow diff fetch must not block the card.
  const [diffOpen, setDiffOpen] = useState(false);
  const [stagedDiff, setStagedDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const tool = data.tool ?? null;
  // Prefer connector/gateway-normalized command, then summary (#332), then
  // raw_input / title fallbacks for older cards that predate server extract.
  const command =
    (tool?.command?.trim() ? tool.command : null) ??
    (tool?.summary?.trim() ? tool.summary : null) ??
    previewRawInput(tool?.raw_input) ??
    tool?.title ??
    tool?.name ??
    data.body ??
    null;
  const title =
    (data.title && data.title !== "ACP permission request" ? data.title : null) ??
    (tool?.title && tool.title.trim() && tool.title !== "ACP permission request"
      ? tool.title
      : null) ??
    "Approval needed";
  const impact = data.body && data.body !== command ? data.body : null;

  // The patch the agent wants to write, distilled by the connector from the ACP
  // tool call. Unlike the staged diff below it needs no fetch — it arrives on the
  // card — so it renders inline: on a file-edit approval it IS the thing to review.
  const agentDiff =
    typeof tool?.diff === "string" && tool.diff.trim() ? tool.diff : null;

  // "View staged diff" is offered only for a real `git commit` whose tool call
  // carries a working directory to diff against.
  const cwd =
    typeof tool?.cwd === "string" && tool.cwd.trim() ? tool.cwd : null;
  const canViewStagedDiff =
    !!channelId && !!cwd && command != null && looksLikeGitCommit(command);

  // Owner is always an approver; for non-owners, check delegations once.
  // Skipped when the caller already resolved may-answer server-side.
  useEffect(() => {
    if (approverOverride !== undefined) return;
    if (resolved || isOwner || !channelId || !currentUserId) return;
    let alive = true;
    listApprovers(botId, channelId)
      .then((res) => {
        if (!alive) return;
        const mine = res.delegates.some((d) => d.user_id === currentUserId);
        setAmApprover(mine || res.owner_id === currentUserId);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [approverOverride, botId, channelId, currentUserId, isOwner, resolved]);

  async function onResolve(id: string) {
    if (!channelId || !requestId || !id || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await resolvePermission(channelId, requestId, id);
      // The resolved card is broadcast back over WS; no local mutation needed.
      // Delivery to the agent is best-effort: the gateway finalizes the card even
      // when the connector/session is gone (delivered:false). Surface that so the
      // collapsed "✓ Approved" isn't misread as "the agent acted on it".
      if (res && res.delivered === false) setUndelivered(true);
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't resolve the approval");
    } finally {
      setBusy(false);
    }
  }

  async function onRequestAccess() {
    if (!channelId || !requestId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestApprovalAccess(channelId, requestId);
      setRequested(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't request access");
    } finally {
      setBusy(false);
    }
  }

  // Toggle the inline staged-diff preview. Fetches lazily on first open; a second
  // click hides it. Uses only the diff-local state above, so it can never block or
  // gate the approve/deny path. A connector-offline / E_NOT_A_REPO error just shows
  // a small inline note and leaves the card fully resolvable.
  async function onToggleStagedDiff() {
    if (diffOpen) {
      setDiffOpen(false);
      return;
    }
    setDiffOpen(true);
    if (stagedDiff != null || diffLoading || !channelId || !cwd) return;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const res = await getGitDiff(channelId, botId, cwd, true);
      setStagedDiff(res.diff);
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : "Couldn't load the staged diff");
    } finally {
      setDiffLoading(false);
    }
  }

  // ── Resolved: a single quiet trace-style line ────────────────────────────
  if (resolved) {
    const expired = data.resolved_kind === "expired";
    const ok = isAllow(data.chosen_kind);
    return (
      <div className="flex items-center gap-2 py-1 text-compact">
        <span
          className={cn(
            expired ? "text-content-muted" : ok ? "text-content-muted" : "text-danger-400"
          )}
        >
          {expired ? "⏱ Expired" : ok ? "✓ Approved" : "✕ Denied"}
        </span>
        {command && (
          <code className="font-code text-content-muted truncate min-w-0">
            {command}
          </code>
        )}
        {data.resolved_by && (
          <span className="text-content-muted whitespace-nowrap" title={data.resolved_by}>
            · {resolverName}
          </span>
        )}
        {undelivered && (
          <span
            className="text-warning-400/90 whitespace-nowrap"
            title="The decision was recorded but couldn't be delivered to the agent (the connector or session may be offline). The agent may not act on it."
          >
            · ⚠ not delivered
          </span>
        )}
      </div>
    );
  }

  const shell = embedded
    ? "overflow-hidden rounded-sm bg-zinc-900/60"
    : "max-w-md overflow-hidden rounded-sm bg-zinc-900/50";

  // ── Pending, not an approver: quiet waiting line ──────────────────────────
  if (!amApprover) {
    return (
      <div className={cn(shell, "flex items-center gap-3 px-3 py-2")}>
        <div className="min-w-0 flex-1">
          <p className="text-compact font-medium text-content-secondary">{title}</p>
          {command && (
            <p className="mt-1 truncate font-code text-compact text-content-muted">
              {command}
            </p>
          )}
        </div>
        <UiButton action="request" variant="plain"
          disabled={busy || requested}
          onClick={onRequestAccess}
          controlSize="compact" className="shrink-0 rounded-sm bg-zinc-800  text-content-primary transition-colors hover:bg-zinc-700 hover:text-content-strong disabled:opacity-50"
        >
          {requested ? "Requested" : "Request access"}
        </UiButton>
      </div>
    );
  }

  // ── Pending, collapsed: one-line preview (skipped when embedded) ──────────
  if (collapsed && !embedded) {
    return (
      <ControlTrigger controlWidth="fill"
        onClick={() => setCollapsed(false)}
        aria-expanded="false"
        title="Show approval details"
        controlSize="regular" className={cn(
 shell,
 "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-left transition-colors hover:bg-zinc-900/70")}
      >
        <div className="min-w-0">
          <p className="text-compact font-medium text-content-secondary">{title}</p>
          {command && (
            <p className="mt-1 truncate font-code text-compact text-content-muted">
              {command}
            </p>
          )}
        </div>
        <span className="flex items-center gap-2 whitespace-nowrap text-compact text-content-muted">
          Details <span className="text-content-muted">⌄</span>
        </span>
      </ControlTrigger>
    );
  }

  // ── Pending, expanded ─────────────────────────────────────────────────────
  return (
    <div className={cn(shell, "space-y-2 px-3 py-3")}>
      <div className="flex min-h-7 items-center gap-2">
        {compact && <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-warning-400/80" />}
        <OverflowText
          fullText={title}
          className="min-w-0 flex-1 text-compact font-medium text-content-secondary"
          touchDisclosure={false}
        />
        {compact && (
          <span className="shrink-0 text-minimal text-warning-400/90">Needs approval</span>
        )}
        {!embedded && (
          <ActionButton action="collapse" context="disclosure"
            onClick={() => setCollapsed(true)}
            accessibleLabel="Collapse approval details"
            className="shrink-0 leading-none text-content-primary transition-colors hover:text-content-strong"
          />
        )}
      </div>

      {command && (
        <div>
          {compact ? (
            <OverflowText
              fullText={command}
              className="w-full rounded-sm bg-zinc-950 px-3 py-2 font-code text-compact text-content-secondary"
              touchDisclosure={false}
            />
          ) : (
            <pre className="m-0 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-zinc-950 px-3 py-2 font-code text-compact leading-reading text-content-secondary">
              {command}
            </pre>
          )}
          {!compact && impact && <p className="mt-2 text-compact text-content-muted">{impact}</p>}
          {!compact && agentDiff && (
            <div className="mt-2 overflow-hidden rounded-sm bg-zinc-950">
              <DiffView diff={agentDiff} className="max-h-72" />
            </div>
          )}
          {!compact && canViewStagedDiff && (
            <div className="mt-2">
              <UiButton action={diffOpen ? "collapse" : "preview"} content="iconText" variant="plain"
                type="button"
                onClick={onToggleStagedDiff}
                title="Preview what this commit will include (git diff --staged)"
                controlSize="compact" className="inline-flex items-center gap-2 rounded-sm bg-zinc-800/60  text-content-primary transition-colors hover:bg-zinc-800 hover:text-content-strong"
              >
                <span className="text-content-muted">±</span>
                {diffOpen ? "Hide staged diff" : "View staged diff"}
                {diffLoading && <span className="text-content-muted">…</span>}
              </UiButton>
              {diffOpen && (
                <div className="mt-2 overflow-hidden rounded-sm bg-zinc-950">
                  {diffLoading ? (
                    <div className="px-3 py-3 text-compact text-content-muted">
                      Loading staged diff…
                    </div>
                  ) : diffError ? (
                    <div
                      className="px-3 py-3 text-compact text-warning-400/80"
                      title={diffError}
                    >
                      Couldn’t load the staged diff
                    </div>
                  ) : (
                    <DiffView diff={stagedDiff ?? ""} className="max-h-72" />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1" aria-label="Approval options">
        {options.map((o) => {
          const id = optId(o);
          const reject = (o.kind ?? "").startsWith("reject");
          return (
            <ControlTrigger
              controlWidth="fill"
              key={id}
              disabled={busy || !id}
              onClick={() => onResolve(id)}
              controlSize="regular"
              className={cn(
                "justify-start bg-zinc-800/55 text-left transition-colors hover:bg-zinc-700/70",
                reject ? "text-danger-300 hover:text-danger-200" : "text-content-primary hover:text-content-strong",
              )}
            >
              <span className="min-w-0 truncate text-compact font-medium">
                {o.name || o.kind || id}
              </span>
              {!compact && o.description && (
                <span className="ml-auto min-w-0 truncate text-minimal text-content-muted">
                  {o.description}
                </span>
              )}
            </ControlTrigger>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="text-compact text-danger-400">
          {error}
        </p>
      )}
    </div>
  );
}
