import { Button as UiButton } from "@/components/ui/button";
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
}

function optId(o: PermissionOption): string {
  return o.option_id ?? o.optionId ?? "";
}

function isAllow(kind?: string | null): boolean {
  return (kind ?? "").startsWith("allow");
}

function isReject(kind?: string | null): boolean {
  return (kind ?? "").startsWith("reject");
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
    (tool?.title && tool.title.trim() && tool.title !== "ACP permission request"
      ? tool.title
      : null) ??
    (data.title && data.title !== "ACP permission request" ? data.title : null) ??
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

  // Radio choices are the allow-variants; "Deny" is the footer escape. If the
  // connector sent no allow option, fall back to showing every option.
  const allowOptions = useMemo(
    () => options.filter((o) => isAllow(o.kind)),
    [options]
  );
  const rejectOption = useMemo(
    () => options.find((o) => isReject(o.kind)),
    [options]
  );
  const radioOptions = allowOptions.length ? allowOptions : options;
  const [selectedId, setSelectedId] = useState("");
  useEffect(() => {
    if (!selectedId && radioOptions[0]) setSelectedId(optId(radioOptions[0]));
  }, [radioOptions, selectedId]);

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
      <div className="flex items-center gap-2 py-0.5 text-compact">
        <span
          className={cn(
            expired ? "text-zinc-400" : ok ? "text-zinc-400" : "text-red-400/70"
          )}
        >
          {expired ? "⏱ Expired" : ok ? "✓ Approved" : "✕ Denied"}
        </span>
        {command && (
          <code className="font-mono text-zinc-400 truncate min-w-0">
            {command}
          </code>
        )}
        {data.resolved_by && (
          <span className="text-zinc-400 whitespace-nowrap" title={data.resolved_by}>
            · {resolverName}
          </span>
        )}
        {undelivered && (
          <span
            className="text-amber-400/90 whitespace-nowrap"
            title="The decision was recorded but couldn't be delivered to the agent (the connector or session may be offline). The agent may not act on it."
          >
            · ⚠ not delivered
          </span>
        )}
      </div>
    );
  }

  const shell = embedded
    ? "w-full overflow-hidden rounded-sm bg-zinc-900/60"
    : "max-w-md overflow-hidden rounded-sm bg-zinc-900/50";

  // ── Pending, not an approver: quiet waiting line ──────────────────────────
  if (!amApprover) {
    return (
      <div className={cn(shell, "flex items-center gap-3 px-3 py-2")}>
        <div className="min-w-0 flex-1">
          <p className="text-compact font-medium text-zinc-200">{title}</p>
          {command && (
            <p className="mt-0.5 truncate font-mono text-compact text-zinc-400">
              {command}
            </p>
          )}
        </div>
        <UiButton variant="plain"
          disabled={busy || requested}
          onClick={onRequestAccess}
          controlSize="compact" className="shrink-0 rounded-sm bg-zinc-800 text-compact text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-50"
        >
          {requested ? "Requested" : "Request access"}
        </UiButton>
      </div>
    );
  }

  // ── Pending, collapsed: one-line preview (skipped when embedded) ──────────
  if (collapsed && !embedded) {
    return (
      <UiButton controlWidth="fill" variant="plain"
        onClick={() => setCollapsed(false)}
        title="Show approval details"
        controlSize="regular" className={cn(
 shell,
 "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-left transition-colors hover:bg-zinc-900/70")}
      >
        <div className="min-w-0">
          <p className="text-compact font-medium text-zinc-200">{title}</p>
          {command && (
            <p className="mt-0.5 truncate font-mono text-compact text-zinc-400">
              {command}
            </p>
          )}
        </div>
        <span className="flex items-center gap-1.5 whitespace-nowrap text-compact text-zinc-400">
          Details <span className="text-zinc-500">⌄</span>
        </span>
      </UiButton>
    );
  }

  // ── Pending, expanded ─────────────────────────────────────────────────────
  return (
    <div className={cn(shell, "space-y-2 px-3 py-2.5")}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-compact font-medium text-zinc-200">{title}</p>
        {!embedded && (
          <UiButton variant="plain"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse"
            title="Collapse"
            className="shrink-0 leading-none text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <span className="inline-block rotate-180 text-compact">⌄</span>
          </UiButton>
        )}
      </div>

      {command && (
        <div>
          <pre className="m-0 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-zinc-950 px-2.5 py-2 font-mono text-compact leading-relaxed text-zinc-300">
            {command}
          </pre>
          {impact && <p className="mt-1.5 text-compact text-zinc-400">{impact}</p>}
          {agentDiff && (
            <div className="mt-2 overflow-hidden rounded-sm bg-zinc-950">
              <DiffView diff={agentDiff} className="max-h-72" />
            </div>
          )}
          {canViewStagedDiff && (
            <div className="mt-2">
              <UiButton variant="plain"
                type="button"
                onClick={onToggleStagedDiff}
                title="Preview what this commit will include (git diff --staged)"
                controlSize="compact" className="inline-flex items-center gap-1.5 rounded-sm bg-zinc-800/60 text-compact text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              >
                <span className="text-zinc-500">±</span>
                {diffOpen ? "Hide staged diff" : "View staged diff"}
                {diffLoading && <span className="text-zinc-500">…</span>}
              </UiButton>
              {diffOpen && (
                <div className="mt-2 overflow-hidden rounded-sm bg-zinc-950">
                  {diffLoading ? (
                    <div className="px-3 py-3 text-compact text-zinc-400">
                      Loading staged diff…
                    </div>
                  ) : diffError ? (
                    <div
                      className="px-3 py-3 text-compact text-amber-400/80"
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

      <div className="space-y-0.5">
        {radioOptions.map((o) => {
          const id = optId(o);
          const sel = id === selectedId;
          return (
            <UiButton controlWidth="fill" variant="plain"
              key={id}
              onClick={() => setSelectedId(id)}
              controlSize="regular" className={cn(
 "flex items-center gap-2.5 rounded-sm text-left transition-colors",
 sel ? "bg-zinc-800/70": "hover:bg-zinc-800/40"
 )}
            >
              <span
                data-design-system-exempt="progress"
                className={cn(
                  "h-3.5 w-3.5 shrink-0 rounded-full",
                  sel ? "bg-indigo-400" : "bg-zinc-700",
                )}
              />
              <span
                className={cn(
                  "min-w-0 truncate text-compact font-medium",
                  sel ? "text-zinc-100" : "text-zinc-300",
                )}
              >
                {o.name || o.kind || id}
              </span>
            </UiButton>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2 pt-0.5">
        {rejectOption && (
          <UiButton variant="plain"
            disabled={busy}
            onClick={() => onResolve(optId(rejectOption))}
            controlSize="compact" className="rounded-sm text-compact font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-50"
          >
            {rejectOption.name || "Deny"}
          </UiButton>
        )}
        <UiButton variant="plain"
          disabled={busy || !selectedId}
          onClick={() => onResolve(selectedId)}
          controlSize="compact" className="rounded-sm bg-zinc-200 text-compact font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
        >
          {allowOptions.length ? "Approve" : "Confirm"}
        </UiButton>
      </div>

      {error && (
        <p role="alert" className="text-compact text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
