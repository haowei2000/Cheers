import { Button as UiButton } from "@/components/ui/button";
import { useState } from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { ackAuthRequired } from "@/api/approval";
import type { AuthMethodPresentation, AuthRequiredContentData, Message } from "@/types";

interface Props {
  message: Message;
  channelId?: string;
  currentUserId?: string;
}

function isEnvAuthMethod(method: AuthMethodPresentation): boolean {
  const id = method.method_id.toLowerCase();
  const typ = (method.auth_type ?? "").toLowerCase();
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
  const methods = data.methods?.length
    ? data.methods
    : data.method_id
      ? [{ method_id: data.method_id, name: data.name, description: data.description, link: data.link, auth_type: data.auth_type, recommended: true }]
      : [];
  const defaultMethod = methods.find((method) => method.recommended) ?? methods[0];
  const [selectedMethodId, setSelectedMethodId] = useState(defaultMethod?.method_id ?? "");
  const selectedMethod = methods.find((method) => method.method_id === selectedMethodId) ?? defaultMethod;
  const resolved = data.resolved === true;
  const isOwner =
    !!currentUserId &&
    !!data.bot_owner_id &&
    currentUserId === data.bot_owner_id;
  const title = data.name?.trim() || "Sign in required";
  const description =
    (methods.length > 1 ? selectedMethod?.description?.trim() : data.description?.trim()) ||
    data.description?.trim() ||
    "This agent needs authentication before it can continue.";
  const link = selectedMethod?.link?.trim() || null;
  const action = data.chosen_action;
  const envAuth = selectedMethod ? isEnvAuthMethod(selectedMethod) : false;

  async function ack(next: "retry" | "cancel") {
    if (!channelId || !data.request_id || busy) return;
    setBusy(next);
    try {
      await ackAuthRequired(
        channelId,
        data.request_id,
        next,
        next === "retry" ? selectedMethodId : undefined
      );
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
      <div className="rounded-sm bg-zinc-900/40 px-3 py-2 text-compact text-content-muted">
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
        <KeyRound className="mt-1 h-4 w-4 shrink-0 text-warning-400" />
        <div className="min-w-0 flex-1">
          <p className="text-regular font-medium text-content-primary">{title}</p>
          <p className="mt-1 whitespace-pre-wrap text-compact leading-reading text-content-muted">
            {description}
          </p>
          {methods.length > 1 && isOwner && (
            <div className="mt-3 grid gap-2">
              {methods.map((method) => (
                /* design-system-exempt: form-field — Agent-advertised auth method choice. */
                <div
                  data-design-system-exempt="form-field"
                  key={method.method_id}
                  className={`flex items-center gap-3 rounded-sm px-3 py-2 ring-1 ring-inset ${
                    selectedMethodId === method.method_id
                      ? "bg-indigo-500/10 text-content-primary ring-indigo-400/60"
                      : "bg-zinc-950/30 ring-zinc-700 hover:ring-zinc-600"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{method.name?.trim() || method.method_id}</span>
                    {method.recommended && <span className="ml-2 text-minimal text-accent-300">Recommended</span>}
                    {method.description && <span className="mt-1 block text-content-muted">{method.description}</span>}
                  </span>
                  <UiButton
                    action="choose"
                    variant={selectedMethodId === method.method_id ? "primary" : "secondary"}
                    controlSize="regular"
                    type="button"
                    disabled={busy !== null}
                    aria-label={`Choose ${method.name?.trim() || method.method_id}`}
                    onClick={() => setSelectedMethodId(method.method_id)}
                  />
                </div>
              ))}
            </div>
          )}
          {selectedMethod?.method_id && (
            <p className="mt-1 font-code text-minimal text-content-muted">
              method: {selectedMethod.method_id}
              {selectedMethod.auth_type ? ` · ${selectedMethod.auth_type}` : ""}
            </p>
          )}
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-compact text-accent-300 hover:text-accent-200"
            >
              Open login page <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : (
            <div className="mt-2 rounded-sm bg-zinc-950/40 px-3 py-2 text-compact leading-reading text-content-muted">
              {data.agent_profile?.login_hint ? (
                <>
                  <p>{data.agent_profile.login_hint}</p>
                  {data.agent_profile.verified_version_range && (
                    <p className="mt-1 text-content-muted">Verified with {data.agent_profile.verified_version_range}.</p>
                  )}
                </>
              ) : envAuth ? (
                <>
                  No login URL for this method — set{" "}
                  <code className="text-content-secondary">ANTHROPIC_API_KEY</code> /{" "}
                  <code className="text-content-secondary">CLAUDE_CODE_OAUTH_TOKEN</code>{" "}
                  (or Codex{" "}
                  <code className="text-content-secondary">OPENAI_API_KEY</code>) in the{" "}
                  <span className="text-content-secondary">connector service</span> env on
                  the agent host (systemd{" "}
                  <code className="text-content-secondary">EnvironmentFile</code>, not
                  just your shell), restart the connector, then confirm below.
                </>
              ) : (
                <>
                  No login URL from the agent. Finish auth on the connector host
                  (CLI login under the same{" "}
                  <code className="text-content-secondary">HOME</code>, or vendor API key
                  in the connector service env), restart if needed, then confirm
                  below.
                </>
              )}
            </div>
          )}
          {isOwner ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <UiButton action="retry" variant="plain"
                type="button"
                disabled={busy !== null || !selectedMethodId}
                onClick={() => void ack("retry")}
                controlSize="regular" className="inline-flex items-center gap-2 rounded-sm bg-indigo-600  font-medium text-content-on-accent hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy === "retry" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {link ? "I've signed in" : "Credentials set — retry"}
              </UiButton>
              <UiButton action="cancel" variant="plain"
                type="button"
                disabled={busy !== null}
                onClick={() => void ack("cancel")}
                controlSize="regular" className="rounded-sm bg-zinc-800  text-content-primary hover:bg-zinc-700 disabled:opacity-50"
              >
                Cancel
              </UiButton>
            </div>
          ) : (
            <p className="mt-2 text-compact text-content-muted">
              Waiting for the bot owner to finish agent authentication.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
