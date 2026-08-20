import { InputWithLeadingIcon } from "@/components/ui/input-with-leading-icon";
import { useEffect, useState } from "react";
import { GitFork, Hash, Link2, Lock, MessagesSquare, Volume2 } from "lucide-react";
import toast from "react-hot-toast";
import { createChannel, deleteChannel } from "@/api/channels";
import { putCodeProfile } from "@/api/channelProfiles";
import {
  bindChannelIntegration,
  initializeChannelIntegration,
  listIntegrationInstallations,
  listIntegrationResources,
  startGitHubInstallation,
  type IntegrationInstallation,
  type IntegrationResource,
} from "@/api/integrations";
import { useChatStore } from "@/stores/chatStore";
import { Dialog } from "@/components/ui/dialog";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { Select } from "@/components/ui/select";
import { isComposing } from "@/lib/ime";
import type { ConversationMode } from "./ConversationModePicker";
import { Button } from "@/components/ui/button";
import { invokeDesktop } from "@/lib/desktop";
import { isTauri } from "@/lib/serverConfig";

// Create a channel in the given workspace, then add it to the store and select it
// (it opens in the normal chat view). Mirrors the NewDmDialog pattern.
export function NewChannelDialog({
  workspaceId,
  onClose,
  onPicked,
}: {
  workspaceId: string;
  onClose: () => void;
  /** Notified after the new channel is selected (mobile pushes the chat screen). */
  onPicked?: () => void;
}) {
  const upsertChannel = useChatStore((s) => s.upsertChannel);
  const selectChannel = useChatStore((s) => s.selectChannel);
  const [name, setName] = useState("");
  const [type, setType] = useState<"public" | "private">("public");
  const [channelType, setChannelType] = useState<"chat" | "discuss" | "code">("chat");
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [installations, setInstallations] = useState<IntegrationInstallation[]>([]);
  const [installationId, setInstallationId] = useState("");
  const [repositories, setRepositories] = useState<IntegrationResource[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const profile = channelType === "code" ? "code" : "standard";
  const conversationMode: ConversationMode = channelType === "discuss" ? "discuss" : "chat";

  function refreshInstallations() {
    return listIntegrationInstallations("github").then((items) => {
      setInstallations(items.filter((item) => item.workspace_id === workspaceId));
      setInstallationId((current) => current || items.find((item) => item.workspace_id === workspaceId)?.installation_id || "");
    }).catch(() => setInstallations([]));
  }

  useEffect(() => {
    if (profile !== "code") return;
    void refreshInstallations();
    const refreshOnFocus = () => { void refreshInstallations(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [profile, workspaceId]);

  useEffect(() => {
    if (profile !== "code" || !installationId) { setRepositories([]); return; }
    void listIntegrationResources("github", installationId)
      .then((items) => setRepositories(items))
      .catch(() => setRepositories([]));
  }, [profile, installationId]);

  async function connectGitHub() {
    if (connectBusy) return;
    setConnectBusy(true);
    try {
      const response = await startGitHubInstallation(workspaceId);
      if (isTauri()) {
        await invokeDesktop("desktop_open_oauth_url", { url: response.authorization_url });
      } else {
        window.open(response.authorization_url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't connect GitHub");
    } finally {
      setConnectBusy(false);
    }
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    let createdChannel: Awaited<ReturnType<typeof createChannel>> | null = null;
    let codeProfileCreated = false;
    try {
      const ch = await createChannel({
        workspace_id: workspaceId,
        name: trimmed,
        type,
        kind: "text",
        features: voiceEnabled ? ["voice"] : [],
        conversation_mode: conversationMode,
      });
      createdChannel = ch;
      if (profile === "code") {
        const repository = repositories.find((item) => item.external_id === repositoryId);
        if (!repository || !installationId) throw new Error("Select a GitHub repository");
        await bindChannelIntegration(ch.channel_id, {
          integration_id: "github",
          installation_id: installationId,
          external_id: repository.external_id,
        });
        await putCodeProfile(ch.channel_id, {
          installation_id: installationId,
          repository: repository.external_id,
          branch: repository.detail.default_branch || "main",
        });
        codeProfileCreated = true;
        await initializeChannelIntegration(ch.channel_id);
      }
      upsertChannel(ch);
      selectChannel(ch.channel_id);
      onPicked?.();
      onClose();
    } catch (e) {
      // Surface the API's human detail (duplicate name, permission, network),
      // not raw JSON — keep the dialog open so the user can fix and retry.
      const raw = e instanceof Error ? e.message : String(e);
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { detail?: string }).detail ?? raw;
      } catch {
        /* not JSON — use raw */
      }
      if (createdChannel && profile === "code" && !codeProfileCreated) {
        const incompleteChannel = createdChannel;
        try {
          await deleteChannel(incompleteChannel.channel_id);
          createdChannel = null;
        } catch {
          // Keep a failed cleanup reachable instead of hiding an existing channel.
          upsertChannel(incompleteChannel);
          selectChannel(incompleteChannel.channel_id);
          onPicked?.();
          onClose();
          toast.error(`Channel created, but GitHub setup is incomplete — ${detail}`);
          return;
        }
      } else if (createdChannel && codeProfileCreated) {
        upsertChannel(createdChannel);
        selectChannel(createdChannel.channel_id);
        onPicked?.();
        onClose();
        toast.error(`Channel created, but repository import needs retry — ${detail}`);
        return;
      }
      toast.error(`Couldn't create channel — ${detail}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New channel" onClose={onClose}>
      <div className="space-y-3">
        <InputWithLeadingIcon
          leading={<Hash />}
          aria-label="Channel name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && void submit()}
          placeholder="Channel name…"
          controlSize="regular"
        />

        <ChoiceGroup
          ariaLabel="Channel visibility"
          value={type}
          onChange={setType}
          options={[
            { value: "public", label: "Public", leading: <Hash /> },
            { value: "private", label: "Private", leading: <Lock /> },
          ]}
        />

        <div className="space-y-2">
          <p className="text-compact font-medium uppercase tracking-label text-content-muted">
            Channel type
          </p>
          <ChoiceGroup
            ariaLabel="Channel type"
            value={channelType}
            onChange={setChannelType}
            className="grid-cols-3"
            options={[
              { value: "chat", label: "Chat", leading: <Hash /> },
              { value: "discuss", label: "Discuss", leading: <MessagesSquare /> },
              { value: "code", label: "Code", leading: <GitFork /> },
            ]}
          />
        </div>

        <CheckboxField
          label={<span className="inline-flex items-center gap-2"><Volume2 className="h-4 w-4" />Enable Voice</span>}
          checked={voiceEnabled}
          onChange={(event) => setVoiceEnabled(event.target.checked)}
        />

        {profile === "code" && (
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <label className="block text-compact text-content-muted" htmlFor="code-installation">GitHub installation</label>
            <Select id="code-installation" controlSize="regular"
              value={installationId} onChange={(event) => { setInstallationId(event.target.value); setRepositoryId(""); }}>
              <option value="">Select installation…</option>
              {installations.map((item) => <option key={item.installation_id} value={item.installation_id}>{item.external_account}</option>)}
            </Select>
            <label className="block text-compact text-content-muted" htmlFor="code-repository">Repository</label>
            <Select id="code-repository" controlSize="regular"
              value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} disabled={!installationId}>
              <option value="">Select repository…</option>
              {repositories.map((item) => <option key={item.external_id} value={item.external_id}>{item.external_id}{item.private ? " · Private" : ""}</option>)}
            </Select>
            {installations.length === 0 && <p className="text-compact text-warning-400">No GitHub App installation is available in this workspace.</p>}
            <Button
              label="Connect GitHub"
              content="iconText"
              variant="secondary"
              controlSize="compact"
              loading={connectBusy}
              onClick={() => void connectGitHub()}
            >
              <Link2 />
            </Button>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <ActionButton action="cancel" context="dialog" onClick={onClose} />
          <ActionButton
            action="create"
            context="form"
            disabled={!name.trim() || busy || (profile === "code" && (!installationId || !repositoryId))}
            loading={busy}
            onClick={() => void submit()}
          />
        </div>
      </div>
    </Dialog>
  );
}
