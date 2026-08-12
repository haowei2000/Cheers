import { Button as UiButton } from "@/components/ui/button";
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

function isEnvAuthMethod(data: AuthRequiredContentData): boolean {
  const id = (data.method_id ?? "").toLowerCase();
  const typ = (data.auth_type ?? "").toLowerCase();
  return (
    typ === "env" ||
    typ === "envvar" ||
    typ === "env_var" ||
    id === "env" ||
    id === "envvar" ||
    id === "env_var" ||
    id === "api-key" ||
    id === "api_key" ||
    id.includes("api-key") ||
    id.includes("api_key")
  );
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
  const envAuth = isEnvAuthMethod(data);

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
      <div className="rounded-sm bg-zinc-900/40 px-3 py-2 text-compact text-zinc-400">
        <span className="inline-flex items-center gap-2">
          <KeyRound className="h-3.5 w-3.5" />
          {label}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-sm bg-amber-500/5 px-3 py-3">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-1 h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-regular font-medium text-zinc-100">{title}</p>
          <p className="mt-1 whitespace-pre-wrap text-compact leading-relaxed text-zinc-400">
            {description}
          </p>
          {data.method_id && (
            <p className="mt-1 font-mono text-minimal text-zinc-500">
              method: {data.method_id}
              {data.auth_type ? ` · ${data.auth_type}` : ""}
            </p>
          )}
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-compact text-indigo-300 hover:text-indigo-200"
            >
              Open login page <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : (
            <div className="mt-2 rounded-sm bg-zinc-950/40 px-3 py-2 text-compact leading-relaxed text-zinc-400">
              {envAuth ? (
                <>
                  No login URL for this method — set{" "}
                  <code className="text-zinc-300">ANTHROPIC_API_KEY</code> /{" "}
                  <code className="text-zinc-300">CLAUDE_CODE_OAUTH_TOKEN</code>{" "}
                  (or Codex{" "}
                  <code className="text-zinc-300">OPENAI_API_KEY</code>) in the{" "}
                  <span className="text-zinc-300">connector service</span> env on
                  the agent host (systemd{" "}
                  <code className="text-zinc-300">EnvironmentFile</code>, not
                  just your shell), restart the connector, then confirm below.
                </>
              ) : (
                <>
                  No login URL from the agent. Finish auth on the connector host
                  (CLI login under the same{" "}
                  <code className="text-zinc-300">HOME</code>, or vendor API key
                  in the connector service env), restart if needed, then confirm
                  below.
                </>
              )}
            </div>
          )}
          {isOwner ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <UiButton variant="plain"
                type="button"
                disabled={busy !== null}
                onClick={() => void ack("retry")}
                controlSize="regular" className="inline-flex items-center gap-2 rounded-sm bg-indigo-600 text-compact font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy === "retry" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {link ? "I've signed in" : "Credentials set — retry"}
              </UiButton>
              <UiButton variant="plain"
                type="button"
                disabled={busy !== null}
                onClick={() => void ack("cancel")}
                controlSize="regular" className="rounded-sm bg-zinc-800 text-compact text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
              >
                Cancel
              </UiButton>
            </div>
          ) : (
            <p className="mt-2 text-compact text-zinc-500">
              Waiting for the bot owner to finish agent authentication.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
