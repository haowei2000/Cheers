import { useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { apiJson } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { PublicPageShell, publicPanelClass } from "@/components/public/PublicPageShell";

interface ConsentPreview {
  client: { client_id: string; client_name: string };
  scopes: string[];
  installations: Array<{
    installation_id: string;
    device_name: string;
    bot_id: string;
    bot_name: string;
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

export default function McpAuthorizePage() {
  const query = window.location.search;
  const request = useMemo(() => Object.fromEntries(new URLSearchParams(query)), [query]);
  const [preview, setPreview] = useState<ConsentPreview | null>(null);
  const [installationId, setInstallationId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiJson<ConsentPreview>(`/mcp/oauth/authorize${query}`)
      .then((value) => {
        setPreview(value);
        setInstallationId(value.installations[0]?.installation_id ?? "");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Authorization request is invalid"));
  }, [query]);

  async function finish(approved: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await apiJson<{ redirect_uri: string }>("/mcp/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({ ...request, installation_id: installationId, approved }),
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
      description="Choose the Agent installation whose existing Cheers permissions will bound this connection."
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
            <label className="block space-y-1 text-compact text-content-muted">
              <span>Act as</span>
              <Select value={installationId} onChange={(event) => setInstallationId(event.target.value)}>
                {preview.installations.map((installation) => (
                  <option key={installation.installation_id} value={installation.installation_id}>
                    {installation.bot_name} · {installation.device_name}
                  </option>
                ))}
              </Select>
            </label>
            <div>
              <p className="mb-2 text-compact font-medium text-content-secondary">Requested access</p>
              <ul className="space-y-1 text-compact text-content-muted">
                {preview.scopes.map((scope) => <li key={scope}>• {scopeLabels[scope] ?? scope}</li>)}
              </ul>
            </div>
            <p className="text-compact text-content-muted">
              OAuth scopes only reduce access. Channel membership, roles, approvals, installation revocation and audit policy still apply to every operation.
            </p>
            <div className="flex justify-end gap-2">
              <Button action="cancel" variant="secondary" disabled={busy} onClick={() => void finish(false)} />
              <Button action="approve" disabled={busy || !installationId} loading={busy} onClick={() => void finish(true)} />
            </div>
          </>
        )}
      </div>
    </PublicPageShell>
  );
}
