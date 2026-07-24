import { useState } from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { ackAuthRequired } from "@/api/approval";
import type { AuthRequiredContentData, Message } from "@/types";

interface Props {
  message: Message;
  channelId?: string;
  currentUserId?: string;
}

/**
 * ACP agent re-auth card. Distinct from tool-permission approvals: the owner
 * completes login on the connector host (or sets env credentials), then taps
 * "I've signed in" so the connector retries `authenticate`.
 */
export function AuthRequiredCard({ message, channelId, currentUserId }: Props) {
  const data = (message.content_data ?? {}) as AuthRequiredContentData;
  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const resolved = data.resolved === true;
  const isOwner =
    !!currentUserId &&
    !!data.bot_owner_id &&
    currentUserId === data.bot_owner_id;
  const title = data.name?.trim() || "Sign in required";
  const description =
    data.description?.trim() ||
    "This agent needs authentication before it can continue.";
  const link = data.link?.trim() || null;
  const action = data.chosen_action;

  async function ack(next: "retry" | "cancel") {
    if (!channelId || !data.request_id || busy) return;
    setBusy(next);
    try {
      await ackAuthRequired(channelId, data.request_id, next);
      toast.success(next === "retry" ? "Retrying agent auth…" : "Auth cancelled");
    } catch (e) {
      toast.error(typeof e === "string" ? e : e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  }

  if (resolved) {
    const label =
      action === "retry"
        ? "Auth acknowledged — retrying"
        : action === "cancel" || data.resolved_kind === "timeout"
          ? "Auth cancelled"
          : "Auth resolved";
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5" />
          {label}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-3">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-100">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">{description}</p>
          {data.method_id && (
            <p className="mt-1 font-mono text-[10px] text-zinc-500">
              method: {data.method_id}
              {data.auth_type ? ` · ${data.auth_type}` : ""}
            </p>
          )}
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
            >
              Open login page <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {isOwner ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void ack("retry")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy === "retry" && <Loader2 className="h-3 w-3 animate-spin" />}
                I&apos;ve signed in
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void ack("cancel")}
                className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-zinc-500">
              Waiting for the bot owner to finish agent authentication.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
