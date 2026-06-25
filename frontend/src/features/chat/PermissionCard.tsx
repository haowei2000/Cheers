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

const HIGH_RISK_KINDS = new Set(["execute", "delete", "move"]);

function optId(o: PermissionOption): string {
  return o.option_id ?? o.optionId ?? "";
}

function isAllow(kind?: string): boolean {
  return (kind ?? "").startsWith("allow");
}

/** Interactive ACP approval card (docs/arch/ACP_APPROVAL_FLOW.md). */
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

  const tool = data.tool ?? null;
  const toolKind = tool?.kind;
  const highRisk = !!toolKind && HIGH_RISK_KINDS.has(toolKind);

  async function onResolve(o: PermissionOption) {
    if (!channelId || !requestId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await resolvePermission(channelId, requestId, optId(o));
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

  return (
    <div className="px-4 py-2">
      <div className="mx-auto max-w-xl rounded-lg border border-zinc-700 bg-zinc-900/60 p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-amber-400 text-sm">🔐</span>
          <span className="text-sm font-medium text-zinc-200">
            {data.title || "Approval needed"}
          </span>
          {toolKind && (
            <span
              className={cn(
                "ml-auto text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded",
                highRisk
                  ? "bg-red-500/20 text-red-300"
                  : "bg-zinc-700/60 text-zinc-300"
              )}
            >
              {toolKind}
            </span>
          )}
        </div>

        {data.body && (
          <p className="text-sm text-zinc-400 whitespace-pre-wrap break-words mb-2">
            {data.body}
          </p>
        )}
        {tool?.name && (
          <code className="block text-xs text-zinc-400 bg-black/30 rounded px-2 py-1 mb-2 break-all">
            {tool.name}
          </code>
        )}

        {resolved ? (
          <div className="text-xs text-zinc-400 border-t border-zinc-800 pt-2 mt-1">
            {isAllow(data.chosen_kind) ? "✅ Approved" : "🚫 Rejected"}
            {data.resolved_by && (
              <>
                {" "}
                · by{" "}
                <span className="text-zinc-300">
                  {data.resolved_by.slice(0, 8)}
                </span>
              </>
            )}
          </div>
        ) : amApprover ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {options.map((o) => (
              <button
                key={optId(o)}
                disabled={busy}
                onClick={() => onResolve(o)}
                className={cn(
                  "text-xs px-3 py-1.5 rounded font-medium disabled:opacity-50 transition-colors",
                  isAllow(o.kind)
                    ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                    : "bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
                )}
              >
                {o.name || o.kind || optId(o)}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs text-zinc-500">
              Waiting for an approver…
            </span>
            <button
              disabled={busy || requested}
              onClick={onRequestAccess}
              className="text-xs px-2.5 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 disabled:opacity-50"
            >
              {requested ? "Requested" : "Request access"}
            </button>
          </div>
        )}

        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
      </div>
    </div>
  );
}
