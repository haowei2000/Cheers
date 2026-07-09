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
 * trace-styled menu rendered inline with the bot's reply — command-first, radio
 * options, minimal footer. While pending it shows expanded (or a one-line
 * collapsed preview); once resolved it shrinks into a single trace-style line so
 * the decision settles back into the bot's progress timeline.
 */
export function PermissionCard({ message, channelId, currentUserId }: Props) {
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
  const [amApprover, setAmApprover] = useState(isOwner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  // Set when the resolve is recorded server-side but couldn't be delivered to the
  // agent (delivered:false) — e.g. the connector/session is offline. The card still
  // collapses to "✓ Approved"; without this the resolver would read that as "the
  // agent ran it", when in fact the agent may never receive the decision.
  const [undelivered, setUndelivered] = useState(false);
  // Pending starts expanded (the user must review); resolved settles collapsed.
  const [collapsed, setCollapsed] = useState(resolved);
  useEffect(() => {
    if (resolved) setCollapsed(true);
  }, [resolved]);

  // Read-side enrichment for `git commit` approvals: fetch + inline-preview the
  // staged diff so a human can see what the commit will actually include. This is
  // deliberately kept on its own state so it NEVER gates approve/deny resolution
  // (which watches only `busy`) — a failed or slow diff fetch must not block the card.
  const [diffOpen, setDiffOpen] = useState(false);
  const [stagedDiff, setStagedDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const tool = data.tool ?? null;
  // Prefer the connector's normalized command (e.g. "/bin/zsh -lc \"…\"") over
  // the raw, often-escaped toolCall.rawInput.command before falling back.
  const command =
    (tool?.command?.trim() ? tool.command : null) ??
    previewRawInput(tool?.raw_input) ??
    tool?.title ??
    tool?.name ??
    data.body ??
    null;
  const title = data.title || "Approval needed";
  const subtitle = `${message.sender_name || "The agent"} is requesting permission.`;
  const impact = data.body && data.body !== command ? data.body : null;

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
  useEffect(() => {
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
  }, [botId, channelId, currentUserId, isOwner, resolved]);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to resolve");
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
      setError(e instanceof Error ? e.message : "failed to request access");
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
      setDiffError(e instanceof Error ? e.message : "couldn't load staged diff");
    } finally {
      setDiffLoading(false);
    }
  }

  // ── Resolved: a single quiet trace-style line ────────────────────────────
  if (resolved) {
    const expired = data.resolved_kind === "expired";
    const ok = isAllow(data.chosen_kind);
    return (
      <div className="flex items-center gap-2 py-0.5 text-xs">
        <span
          className={cn(
            expired ? "text-zinc-500" : ok ? "text-zinc-400" : "text-rose-400/70"
          )}
        >
          {expired ? "⏱ Expired" : ok ? "✓ Approved" : "✕ Denied"}
        </span>
        {command && (
          <code className="font-mono text-zinc-500 truncate min-w-0">
            {command}
          </code>
        )}
        {data.resolved_by && (
          <span className="text-zinc-600 whitespace-nowrap" title={data.resolved_by}>
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

  const shell =
    "max-w-md rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden";

  // ── Pending, not an approver: quiet waiting line ──────────────────────────
  if (!amApprover) {
    return (
      <div className={cn(shell, "flex items-center gap-3 px-3 py-2.5")}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-300">{title}</p>
          {command && (
            <p className="text-xs font-mono text-zinc-500 truncate mt-0.5">
              {command}
            </p>
          )}
        </div>
        <button
          disabled={busy || requested}
          onClick={onRequestAccess}
          className="shrink-0 h-7 px-2.5 text-xs rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {requested ? "Requested" : "Request access"}
        </button>
      </div>
    );
  }

  // ── Pending, collapsed: one-line preview ──────────────────────────────────
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        title="Show approval details"
        className={cn(
          shell,
          "w-full grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-zinc-900/70"
        )}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">{title}</p>
          {command && (
            <p className="text-xs font-mono text-zinc-500 truncate mt-0.5">
              {command}
            </p>
          )}
        </div>
        <span className="flex items-center gap-1.5 text-xs text-zinc-500 whitespace-nowrap">
          Details <span className="text-zinc-600">⌄</span>
        </span>
      </button>
    );
  }

  // ── Pending, expanded ─────────────────────────────────────────────────────
  return (
    <div className={shell}>
      <header className="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-zinc-800">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">{title}</p>
          <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          aria-label="Collapse"
          title="Collapse"
          className="shrink-0 text-zinc-600 hover:text-zinc-300 leading-none"
        >
          <span className="inline-block rotate-180 text-sm">⌄</span>
        </button>
      </header>

      {command && (
        <div className="px-3 py-2.5 border-b border-zinc-800 bg-zinc-950/40">
          <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1.5">
            Command
          </p>
          <pre className="m-0 text-xs font-mono text-zinc-300 bg-black/40 border border-zinc-800 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-32 overflow-auto">
            {command}
          </pre>
          {impact && <p className="text-xs text-zinc-500 mt-2">{impact}</p>}
          {canViewStagedDiff && (
            <div className="mt-2">
              <button
                type="button"
                onClick={onToggleStagedDiff}
                title="Preview what this commit will include (git diff --staged)"
                className="inline-flex items-center gap-1.5 h-6 px-2 text-[11px] rounded border border-zinc-800 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              >
                <span className="text-zinc-600">±</span>
                {diffOpen ? "Hide staged diff" : "View staged diff"}
                {diffLoading && <span className="text-zinc-600">…</span>}
              </button>
              {diffOpen && (
                <div className="mt-2 rounded border border-zinc-800 bg-black/30 overflow-hidden">
                  {diffLoading ? (
                    <div className="px-3 py-3 text-[11px] text-zinc-600">
                      Loading staged diff…
                    </div>
                  ) : diffError ? (
                    <div
                      className="px-3 py-3 text-[11px] text-amber-400/80"
                      title={diffError}
                    >
                      couldn’t load staged diff
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

      <div className="p-1.5 border-b border-zinc-800">
        {radioOptions.map((o) => {
          const id = optId(o);
          const sel = id === selectedId;
          return (
            <button
              key={id}
              onClick={() => setSelectedId(id)}
              className={cn(
                "w-full grid grid-cols-[16px_minmax(0,1fr)] gap-2.5 text-left px-2.5 py-2 rounded-md transition-colors",
                sel ? "bg-zinc-800/70" : "hover:bg-zinc-800/40"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 w-3.5 h-3.5 rounded-full",
                  sel
                    ? "border-[4px] border-indigo-400"
                    : "border border-zinc-600"
                )}
              />
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-[13px] font-medium leading-tight",
                    sel ? "text-zinc-100" : "text-zinc-300"
                  )}
                >
                  {o.name || o.kind || id}
                </span>
                {o.description && (
                  <span className="block text-xs text-zinc-500 mt-0.5">
                    {o.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <footer className="flex items-center justify-end gap-2 px-2.5 py-2.5 bg-zinc-900/40">
        {rejectOption && (
          <button
            disabled={busy}
            onClick={() => onResolve(optId(rejectOption))}
            className="h-8 px-3 text-xs font-medium rounded-md text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
          >
            {rejectOption.name || "Deny"}
          </button>
        )}
        <button
          disabled={busy || !selectedId}
          onClick={() => onResolve(selectedId)}
          className="h-8 px-3.5 text-xs font-semibold rounded-md bg-zinc-200 text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {allowOptions.length ? "Approve" : "Confirm"}
        </button>
      </footer>

      {error && <p className="text-xs text-rose-400 px-3 pb-2">{error}</p>}
    </div>
  );
}
