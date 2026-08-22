import { InputWithLeadingIcon } from "@/components/ui/input-with-leading-icon";
import { useEffect, useState } from "react";
import { FolderGit2, GitFork, Github, Hash, Link2, Lock, MessagesSquare, Server, Volume2 } from "lucide-react";
import toast from "react-hot-toast";
import { addChannelMember, createChannel, deleteChannel } from "@/api/channels";
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
import { getFleetHosts, type FleetHost } from "@/api/fleet";
import { listHostRepositories, type HostRepository } from "@/api/bots";
import { createChannelBotSession, setPrimaryChannelBotSession } from "@/api/sessionControl";

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
  const [sourceMode, setSourceMode] = useState<"local" | "github">("local");
  const [hosts, setHosts] = useState<FleetHost[]>([]);
  const [targetHostId, setTargetHostId] = useState("");
  const [hostRepositories, setHostRepositories] = useState<HostRepository[]>([]);
  const [checkoutPath, setCheckoutPath] = useState("");
  const [installations, setInstallations] = useState<IntegrationInstallation[]>([]);
  const [installationId, setInstallationId] = useState("");
  const [repositories, setRepositories] = useState<IntegrationResource[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const profile = channelType === "code" ? "code" : "standard";
  const conversationMode: ConversationMode = channelType === "discuss" ? "discuss" : "chat";

  useEffect(() => {
    if (profile !== "code") return;
    void getFleetHosts().then((items) => {
      const available = items.filter((item) => item.status === "active" && !item.revoked_at);
      setHosts(available);
      setTargetHostId((current) => current || available.find((item) => item.online)?.host_id || "");
    }).catch(() => setHosts([]));
    if (sourceMode !== "github") return;
    const refreshInstallations = () => listIntegrationInstallations("github").then((items) => {
      const workspaceItems = items.filter((item) => item.workspace_id === workspaceId);
      setInstallations(workspaceItems);
      setInstallationId((current) => current || workspaceItems[0]?.installation_id || "");
    }).catch(() => setInstallations([]));
    void refreshInstallations();
    const refreshOnFocus = () => { void refreshInstallations(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [profile, sourceMode, workspaceId]);

  useEffect(() => {
    if (profile !== "code" || sourceMode !== "github" || !installationId) { setRepositories([]); return; }
    void listIntegrationResources("github", installationId)
      .then((items) => setRepositories(items))
      .catch(() => setRepositories([]));
  }, [profile, sourceMode, installationId]);

  useEffect(() => {
    const host = hosts.find((item) => item.host_id === targetHostId);
    if (profile !== "code" || !host?.online) {
      setHostRepositories([]);
      setCheckoutPath("");
      return;
    }
    void listHostRepositories(host.bot_id, host.host_id)
      .then((result) => {
        setHostRepositories(result.repositories);
        setCheckoutPath((current) => current || result.repositories.find((repo) => repo.path === result.default_cwd)?.path || result.repositories[0]?.path || "");
      })
      .catch(() => {
        setHostRepositories([]);
        setCheckoutPath("");
      });
  }, [hosts, profile, targetHostId]);

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
      const target = hosts.find((item) => item.host_id === targetHostId);
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
        if (target) {
          await addChannelMember(ch.channel_id, {
            member_id: target.bot_id,
            member_type: "bot",
          });
          if (checkoutPath) {
            const session = await createChannelBotSession(ch.channel_id, target.bot_id, {
              cwd: checkoutPath,
            });
            await setPrimaryChannelBotSession(ch.channel_id, target.bot_id, session.session_id);
          }
        }
        const repository = sourceMode === "github"
          ? repositories.find((item) => item.external_id === repositoryId)
          : undefined;
        if (sourceMode === "github") {
          if (!repository || !installationId) throw new Error("Select a GitHub repository");
          await bindChannelIntegration(ch.channel_id, {
            integration_id: "github",
            installation_id: installationId,
            external_id: repository.external_id,
          });
        }
        await putCodeProfile(ch.channel_id, {
          remote_source: repository && installationId ? {
            kind: "github",
            installation_id: installationId,
            repository: repository.external_id,
            branch: repository.detail.default_branch || "main",
          } : undefined,
          execution_target: target ? { bot_id: target.bot_id, host_id: target.host_id } : undefined,
        });
        codeProfileCreated = true;
        if (repository) await initializeChannelIntegration(ch.channel_id);
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
        toast.error(`Channel created, but project setup needs retry — ${detail}`);
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
            <p className="text-compact font-medium uppercase tracking-label text-content-muted">Repository source</p>
            <ChoiceGroup
              ariaLabel="Repository source"
              value={sourceMode}
              onChange={setSourceMode}
              options={[
                { value: "local", label: "Local", leading: <FolderGit2 /> },
                { value: "github", label: "GitHub", leading: <Github /> },
              ]}
            />

            {sourceMode === "github" && (
              <div className="space-y-2">
                {installations.length > 1 && (
                  <>
                    <span className="block text-compact text-content-muted">GitHub account</span>
                    <Select aria-label="GitHub account" controlSize="regular"
                      value={installationId} onChange={(event) => { setInstallationId(event.target.value); setRepositoryId(""); }}>
                      <option value="">Select account…</option>
                      {installations.map((item) => <option key={item.installation_id} value={item.installation_id}>{item.external_account}</option>)}
                    </Select>
                  </>
                )}
                <span className="block text-compact text-content-muted">Repository</span>
                <Select aria-label="Repository" controlSize="regular"
                  value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} disabled={!installationId}>
                  <option value="">Select repository…</option>
                  {repositories.map((item) => <option key={item.external_id} value={item.external_id}>{item.external_id}{item.private ? " · Private" : ""}</option>)}
                </Select>
                {installations.length === 0 && (
                  <Button action="connect" content="iconText" variant="secondary" controlSize="compact"
                    loading={connectBusy} onClick={() => void connectGitHub()}>
                    <Link2 />
                  </Button>
                )}
              </div>
            )}

            <span className="block text-compact text-content-muted">Execution target</span>
            <Select aria-label="Execution target" controlSize="regular" value={targetHostId}
              onChange={(event) => { setTargetHostId(event.target.value); setCheckoutPath(""); }}>
              <option value="">Set up later</option>
              {hosts.map((host) => (
                <option key={host.host_id} value={host.host_id} disabled={!host.online}>
                  {host.bot_name} · {host.device_name}{host.online ? "" : " · Offline"}
                </option>
              ))}
            </Select>
            {hostRepositories.length > 0 && (
              <>
                <span className="block text-compact text-content-muted">Repository checkout</span>
                <Select aria-label="Repository checkout" controlSize="regular" value={checkoutPath}
                  onChange={(event) => setCheckoutPath(event.target.value)}>
                  {hostRepositories.map((repository) => (
                    <option key={repository.path} value={repository.path}>
                      {repository.path}{repository.branch ? ` · ${repository.branch}` : ""}
                    </option>
                  ))}
                </Select>
              </>
            )}
            {hosts.length === 0 && (
              <p className="inline-flex items-center gap-2 text-compact text-content-muted">
                <Server className="h-4 w-4" /> No connected Bot Hosts
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <ActionButton action="cancel" context="dialog" onClick={onClose} />
          <ActionButton
            action="create"
            context="form"
            disabled={!name.trim() || busy || (profile === "code" && sourceMode === "github" && (!installationId || !repositoryId))}
            loading={busy}
            onClick={() => void submit()}
          />
        </div>
      </div>
    </Dialog>
  );
}
