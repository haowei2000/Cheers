import { useMemo, useState } from "react";
import { ExternalLink, KeyRound, Loader2, MessageCircleQuestion } from "lucide-react";
import toast from "react-hot-toast";
import { Button as UiButton } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
import { resolveElicitation } from "@/api/approval";
import type { ElicitationContentData, Message } from "@/types";

/** Inputs needed to bind one persisted card to its resolution endpoint. */
interface Props { message: Message; channelId?: string; currentUserId?: string }

/** Renders ACP v1 form and URL elicitation with explicit user consent. */
export function ElicitationCard({ message, channelId, currentUserId }: Props) {
  const data = (message.content_data ?? {}) as ElicitationContentData;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const properties = data.requested_schema?.properties ?? {};
  const required = new Set(data.requested_schema?.required ?? []);
  const host = useMemo(() => {
    try { return data.url ? new URL(data.url).host : ""; } catch { return ""; }
  }, [data.url]);
  const isMcpOAuth = data.mode === "url" && data.interaction_kind === "mcp_oauth";
  const isInitiatingUser = !data.initiating_user_id || data.initiating_user_id === currentUserId;

  /** Submits one terminal answer after client-side required-field checks. */
  async function resolve(action: "accept" | "decline" | "cancel") {
    if (!channelId || !data.request_id || busy) return false;
    if (action === "accept" && data.mode === "form") {
      const missing = [...required].filter((name) => {
        const value = values[name];
        return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
      });
      if (missing.length) {
        toast.error(`Complete required field: ${missing[0]}`);
        return false;
      }
    }
    setBusy(action);
    try {
      await resolveElicitation(
        channelId,
        data.request_id,
        action,
        action === "accept" && data.mode === "form" ? values : undefined,
      );
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not answer request");
      return false;
    } finally { setBusy(null); }
  }

  /** Opens a blank, isolated window from the click gesture and navigates after consent is recorded. */
  async function openUrl() {
    if (!data.url) return;
    // Create only from the click gesture; never prefetch or auto-navigate sensitive URLs.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    if (await resolve("accept")) {
      if (popup) popup.location.href = data.url;
      else toast.error("Allow pop-ups to continue to the external site");
    } else popup?.close();
  }

  if (data.resolved) {
    return <div className="rounded-sm bg-zinc-900/40 px-3 py-2 text-compact text-content-muted">
      <span className="inline-flex items-center gap-2">{isMcpOAuth ? <KeyRound className="h-3.5 w-3.5" /> : <MessageCircleQuestion className="h-3.5 w-3.5" />}
        {data.status === "completed" ? (isMcpOAuth ? "Cheers MCP connected" : "Interaction completed") : data.status === "accept" ? (isMcpOAuth ? "Authorization opened — waiting for the Agent to confirm" : "Response submitted") : "Interaction declined"}
      </span>
    </div>;
  }

  return <div className={`rounded-sm px-3 py-3 ${isMcpOAuth ? "bg-amber-500/5" : "bg-indigo-500/5"}`}>
    <div className="flex items-start gap-2">
      {isMcpOAuth ? <KeyRound className="mt-1 h-4 w-4 shrink-0 text-warning-400" /> : <MessageCircleQuestion className="mt-1 h-4 w-4 shrink-0 text-accent-300" />}
      <div className="min-w-0 flex-1">
        {isMcpOAuth && <p className="mb-1 text-regular font-medium text-content-primary">Connect Cheers MCP</p>}
        <p className="whitespace-pre-wrap text-regular text-content-primary">{data.message || message.content}</p>
        {data.mode === "form" && <div className="mt-3 space-y-3">
          {Object.entries(properties).map(([name, schema]) => {
            const label = schema.title || name;
            if (schema.type === "boolean") return <CheckboxField key={name} label={label} checked={Boolean(values[name])} onChange={e => setValues(v => ({...v, [name]:e.target.checked}))} />;
            const choices = schema.enum ?? schema.items?.enum;
            return <label key={name} className="block text-compact text-content-secondary">
              <span>{label}{required.has(name) ? " *" : ""}</span>
              {schema.description && <span className="ml-2 text-content-muted">{schema.description}</span>}
              {choices ? <UiSelect controlSize="regular" multiple={schema.type === "array"} className="mt-1" value={schema.type === "array" ? ((values[name] as Array<string | number> | undefined) ?? []).map(String) : String(values[name] ?? "")} onChange={e => setValues(v => ({...v, [name]: schema.type === "array" ? Array.from(e.target.selectedOptions, option => choices.find(choice => String(choice) === option.value) ?? option.value) : choices.find(choice => String(choice) === e.target.value) ?? e.target.value}))}>
                {schema.type !== "array" && <option value="">Select…</option>}{choices.map(choice => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}
              </UiSelect> : <UiInput controlSize="regular" className="mt-1" type={schema.type === "number" || schema.type === "integer" ? "number" : "text"} required={required.has(name)} value={String(values[name] ?? "")} onChange={e => setValues(v => ({...v, [name]: schema.type === "number" || schema.type === "integer" ? Number(e.target.value) : e.target.value}))} />}
            </label>;
          })}
        </div>}
        {data.mode === "url" && <div className="mt-3 rounded-sm bg-zinc-950/40 px-3 py-2 text-compact text-content-muted">
          <p>{isMcpOAuth ? "Authorize this Agent to use Cheers tools on" : "Continue on"} <span className="font-medium text-content-secondary">{host || "external site"}</span>. Cheers will not open or prefetch it until you confirm.</p>
          {data.url && <code className="mt-1 block break-all text-content-secondary">{data.url}</code>}
          {isMcpOAuth && <p className="mt-2 text-content-muted">Credentials stay in the Agent&apos;s OAuth store and are never returned through ACP or added to model context.</p>}
        </div>}
        {isInitiatingUser ? <div className="mt-3 flex flex-wrap gap-2">
          <UiButton action="link" variant="plain" disabled={busy !== null} onClick={() => data.mode === "url" ? void openUrl() : void resolve("accept")} controlSize="regular" className="gap-2 rounded-sm bg-indigo-600 text-content-on-accent hover:bg-indigo-500">
            {busy === "accept" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{data.mode === "url" ? <>{isMcpOAuth ? "Authorize Cheers MCP" : "Continue"} <ExternalLink className="h-3.5 w-3.5" /></> : "Submit"}
          </UiButton>
          <UiButton action="cancel" variant="plain" disabled={busy !== null} onClick={() => void resolve("decline")} controlSize="regular" className="rounded-sm bg-zinc-800 hover:bg-zinc-700">Decline</UiButton>
        </div> : <p className="mt-3 text-compact text-content-muted">Waiting for the user who started this Agent request to respond.</p>}
      </div>
    </div>
  </div>;
}
