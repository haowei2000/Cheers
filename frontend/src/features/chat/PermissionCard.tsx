import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import {
  resolvePermission,
  requestApprovalAccess,
  listApprovers,
} from "@/api/approval";
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
  const requestId = data.request_id ?? "";
  const options = useMemo(() => data.options ?? [], [data.options]);
  const resolved = data.resolved === true;

  const isOwner = !!currentUserId && currentUserId === data.bot_owner_id;
  const [amApprover, setAmApprover] = useState(isOwner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  // Pending starts expanded (the user must review); resolved settles collapsed.
  const [collapsed, setCollapsed] = useState(resolved);
  useEffect(() => {
    if (resolved) setCollapsed(true);
  }, [resolved]);

  const tool = data.tool ?? null;
  const command =
    previewRawInput(tool?.raw_input) ??
    tool?.title ??
    tool?.name ??
    data.body ??
    null;
  const title = data.title || "Approval needed";
  const subtitle = `${message.sender_name || "The agent"} is requesting permission.`;
  const impact = data.body && data.body !== command ? data.body : null;

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
      await resolvePermission(channelId, requestId, id);
      // The resolved card is broadcast back over WS; no local mutation needed.
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

  // ── Resolved: a single quiet trace-style line ────────────────────────────
  if (resolved) {
    const expired = data.resolved_kind === "expired";
    const ok = isAllow(data.chosen_kind);
    return (
      <div className="flex items-center gap-2 py-0.5 text-xs">
        <span
          className={cn(
            "font-medium",
            expired ? "text-zinc-500" : ok ? "text-emerald-400/90" : "text-rose-400/90"
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
          <span className="text-zinc-600 whitespace-nowrap">
            · {data.resolved_by.slice(0, 8)}
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
