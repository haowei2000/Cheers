import { useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { apiJson } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import { HelpLabel } from "@/components/ui/help-text";
import { Spinner } from "@/components/ui/spinner";
import { PublicPageShell, publicPanelClass } from "@/components/public/PublicPageShell";

interface ConsentPreview {
  client: { client_id: string; client_name: string };
  scopes: string[];
  hosts: Array<{
    host_id: string;
    device_name: string;
    bot_id: string;
    bot_name: string;
    channels: Array<{ channel_id: string; name: string }>;
  }>;
  redirect_uri: string;
}

const scopeLabels: Record<string, string> = {
  "cheers:read": "Read channels and Agent resources",
  "cheers:messages:write": "Send channel messages",
  "cheers:files:write": "Deliver channel attachments",
  "cheers:workspace:write": "Modify Cheers Desk files",
  "cheers:profile:write": "Update the Agent profile",
  "cheers:membership:write": "Open DMs or leave channels",
  "cheers:task-claims:write": "Respond to assigned task claims",
};

export function selectConsentTarget(hosts: ConsentPreview["hosts"], requestedChannel?: string) {
  const host = requestedChannel
    ? hosts.find((host) => host.channels.some((channel) => channel.channel_id === requestedChannel))
    : hosts.find((host) => host.channels.length > 0);
  return {
    hostId: host?.host_id ?? "",
    channelId: requestedChannel ? (host ? requestedChannel : "") : host?.channels[0]?.channel_id ?? "",
  };
}

export default function McpAuthorizePage() {
  const query = window.location.search;
  const request = useMemo(() => Object.fromEntries(new URLSearchParams(query)), [query]);
  const [preview, setPreview] = useState<ConsentPreview | null>(null);
  const [hostId, setHostId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiJson<ConsentPreview>(`/mcp/oauth/authorize${query}`)
      .then((value) => {
        setPreview(value);
        const target = selectConsentTarget(value.hosts, request.cheers_channel);
        setHostId(target.hostId);
        setChannelId(target.channelId);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Authorization request is invalid"));
  }, [query, request]);

  async function finish(approved: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await apiJson<{ redirect_uri: string }>("/mcp/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({
          ...request,
          cheers_channel: channelId || undefined,
          host_id: hostId,
          approved,
        }),
      });
      window.location.replace(result.redirect_uri);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Authorization failed");
      setBusy(false);
    }
  }

  return (
    <PublicPageShell
      eyebrow="Cheers · MCP authorization"
      title="Connect an MCP client"
      description="Choose an Agent host and channel. This connection will be limited to that channel."
    >
      <div className={`${publicPanelClass} space-y-4`}>
        {!preview && !error && <Spinner contentSize="large" className="mx-auto text-content-muted" />}
        {error && <p role="alert" className="text-regular text-danger-300">{error}</p>}
        {preview && (
          <>
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-accent-300" />
              <div className="min-w-0">
                <p className="text-regular font-medium text-content-primary">{preview.client.client_name}</p>
                <p className="truncate text-compact text-content-muted">{preview.client.client_id}</p>
              </div>
            </div>
            {preview.hosts.length === 0 && <p role="alert" className="text-regular text-content-secondary">No Agent hosts are available. Connect an Agent and add it to your channel, then reopen this request.</p>}
            <Field label="Act as" htmlFor="authorize-host">
              <Select
                id="authorize-host"
                value={hostId}
                onChange={(event) => {
                  const nextHost = preview.hosts.find((host) => host.host_id === event.target.value);
                  setHostId(event.target.value);
                  setChannelId(request.cheers_channel
                    ? nextHost?.channels.find((channel) => channel.channel_id === request.cheers_channel)?.channel_id ?? ""
                    : nextHost?.channels[0]?.channel_id ?? "");
                }}
              >
                {!hostId && <option value="">Choose an Agent host</option>}
                {preview.hosts.map((host) => (
                  <option key={host.host_id} value={host.host_id}>
                    {host.bot_name} · {host.device_name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Limit access to channel" htmlFor="authorize-channel">
              <Select
                id="authorize-channel"
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
                disabled={!!request.cheers_channel}
              >
                {!channelId && <option value="">No matching channel</option>}
                {(preview.hosts.find((host) => host.host_id === hostId)?.channels ?? [])
                  .map((channel) => (
                    <option key={channel.channel_id} value={channel.channel_id}>
                      {channel.name}
                    </option>
                  ))}
              </Select>
            </Field>
            {!channelId && (
              <p role="alert" className="text-compact text-danger-300">
                {request.cheers_channel ? "Choose a host with access to the requested channel." : "This host has no channel that you can authorize."}
              </p>
            )}
            <div>
              <p className="mb-2 text-compact font-medium text-content-secondary"><HelpLabel help="OAuth scopes only reduce access. Channel membership, roles, approvals, host revocation and audit policy still apply to every operation.">Requested access</HelpLabel></p>
              <ul className="space-y-1 text-compact text-content-muted">
                {preview.scopes.map((scope) => <li key={scope}>• {scopeLabels[scope] ?? scope}</li>)}
              </ul>
            </div>
            <div className="flex justify-end gap-2">
              <Button action="cancel" variant="secondary" disabled={busy} onClick={() => void finish(false)} />
              <Button action="approve" disabled={busy || !hostId || !channelId} loading={busy} onClick={() => void finish(true)} />
            </div>
          </>
        )}
      </div>
    </PublicPageShell>
  );
}
