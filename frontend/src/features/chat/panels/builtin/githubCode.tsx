import { useEffect, useState } from "react";
import { Folder, GitBranch, GitCommitHorizontal, GitFork, Server } from "lucide-react";
import toast from "react-hot-toast";
import { putCodeProfile } from "@/api/channelProfiles";
import { addChannelMember } from "@/api/channels";
import { getFleetHosts, type FleetHost } from "@/api/fleet";
import { listHostRepositories, type HostRepository } from "@/api/bots";
import {
  createChannelBotSession,
  setPrimaryChannelBotSession,
} from "@/api/sessionControl";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { bustBotControls } from "@/features/chat/sessionControlsCache";
import { registerPanel, type PanelContext } from "../registry";
import { PanelShell } from "../definePanel";

// The `code` profile's status, on all three surfaces it appears on. Before the panels
// refactor this lived in three files against three registries and three context types
// (extensions/githubCode.tsx, panels/GitHubCodePanel.tsx, panels/GitHubCodeWorkbenchPanel.tsx),
// each re-deriving the same four fields from the same ChannelProfile. The presentations
// genuinely differ — a header chip, a lane card, a Workbench status strip — but the facts
// do not, so they are read once here.

interface CodeFacts {
  repository: string;
  branch: string;
  hasRemoteSource: boolean;
  target: string | null;
  targetOnline: boolean | null;
  state: string;
  head: string | null;
  lastError: string | null;
}

/** Read the `code` profile's facts. The profile is capability-filtered by the gateway and
 *  never carries OAuth or App installation credentials — see docs/arch/PLUGIN_SYSTEM.md. */
function codeFacts(ctx: PanelContext): CodeFacts | null {
  const profile = ctx.profile;
  if (!profile) return null;
  const str = (value: unknown, fallback: string | null) =>
    typeof value === "string" ? value : fallback;
  const source = profile.config.remote_source ?? null;
  const target = profile.config.execution_target ?? null;
  const targetBot = str(profile.status.target_bot_name, str(target?.bot_id, null));
  const targetDevice = str(profile.status.target_device, null);
  return {
    repository: str(source?.repository, "Local repository") as string,
    branch: str(source?.branch, "local") as string,
    hasRemoteSource: source?.kind === "github",
    target: targetBot ? [targetBot, targetDevice].filter(Boolean).join(" · ") : null,
    targetOnline: typeof profile.status.target_online === "boolean" ? profile.status.target_online : null,
    state: str(profile.status.state, "unconfigured") as string,
    head: str(profile.status.head_commit, null),
    lastError: str(profile.status.last_error, null),
  };
}

function stateTone(state: string): string {
  if (state === "ready") return "text-success-400";
  if (state === "error") return "text-danger-400";
  return "text-warning-400";
}

function ExecutionTargetDialog({
  ctx,
  open,
  onClose,
}: {
  ctx: PanelContext;
  open: boolean;
  onClose: () => void;
}) {
  const [hosts, setHosts] = useState<FleetHost[]>([]);
  const [hostId, setHostId] = useState("");
  const [repositories, setRepositories] = useState<HostRepository[]>([]);
  const [checkoutPath, setCheckoutPath] = useState("");
  const [customPath, setCustomPath] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void getFleetHosts()
      .then((items) => {
        const available = items.filter(
          (item) => item.status === "active" && !item.revoked_at && item.online,
        );
        setHosts(available);
        const currentHost = ctx.profile?.config.execution_target?.host_id;
        setHostId(
          available.find((item) => item.host_id === currentHost)?.host_id
            ?? available[0]?.host_id
            ?? "",
        );
      })
      .catch(() => setHosts([]));
  }, [ctx.profile?.config.execution_target?.host_id, open]);

  useEffect(() => {
    const host = hosts.find((item) => item.host_id === hostId);
    if (!open || !host) {
      setRepositories([]);
      setCheckoutPath("");
      return;
    }
    void listHostRepositories(host.bot_id, host.host_id)
      .then((result) => {
        setRepositories(result.repositories);
        setCheckoutPath(
          result.repositories.find((repo) => repo.path === result.default_cwd)?.path
            ?? result.repositories[0]?.path
            ?? result.default_cwd
            ?? "",
        );
      })
      .catch(() => {
        setRepositories([]);
        setCheckoutPath("");
      });
  }, [hostId, hosts, open]);

  async function save() {
    const host = hosts.find((item) => item.host_id === hostId);
    if (!host || saving) return;
    setSaving(true);
    try {
      await addChannelMember(ctx.channelId, {
        member_id: host.bot_id,
        member_type: "bot",
      });
      const session = await createChannelBotSession(
        ctx.channelId,
        host.bot_id,
        checkoutPath.trim() ? { cwd: checkoutPath.trim() } : undefined,
      );
      await setPrimaryChannelBotSession(ctx.channelId, host.bot_id, session.session_id);
      bustBotControls(ctx.channelId, host.bot_id);
      await putCodeProfile(ctx.channelId, {
        remote_source: ctx.profile?.config.remote_source,
        execution_target: { bot_id: host.bot_id, host_id: host.host_id },
      });
      toast.success("Execution target updated");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update execution target");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <Dialog title="Repository & execution target" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <span className="block text-compact text-content-muted mb-1">Bot Host</span>
          <Select
            aria-label="Bot Host"
            controlSize="regular"
            value={hostId}
            onChange={(event) => setHostId(event.target.value)}
          >
            <option value="">No online Hosts</option>
            {hosts.map((host) => (
              <option key={host.host_id} value={host.host_id}>
                {host.bot_name} · {host.device_name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="block text-compact text-content-muted">
              Repository checkout / Working directory
            </span>
            {repositories.length > 0 && (
              <ControlTrigger
                type="button"
                controlSize="compact"
                controlWidth="content"
                onClick={() => setCustomPath((prev) => !prev)}
              >
                {customPath ? "Choose from scanned repos" : "Enter custom path"}
              </ControlTrigger>
            )}
          </div>
          {repositories.length > 0 && !customPath ? (
            <Select
              aria-label="Repository checkout"
              controlSize="regular"
              value={checkoutPath}
              onChange={(event) => setCheckoutPath(event.target.value)}
            >
              {repositories.map((repository) => (
                <option key={repository.path} value={repository.path}>
                  {repository.path}{repository.branch ? ` · ${repository.branch}` : ""}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              aria-label="Repository checkout / Working directory"
              placeholder="/path/to/project"
              value={checkoutPath}
              onChange={(event) => setCheckoutPath(event.target.value)}
              controlSize="regular"
            />
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <ActionButton action="cancel" context="dialog" onClick={onClose} />
        <ActionButton
          action="save"
          context="form"
          loading={saving}
          disabled={!hostId || saving}
          onClick={() => void save()}
        />
      </div>
    </Dialog>
  );
}

/** Header: a compact chip beside the channel title. Hidden below `lg` — the header has
 *  no room for it on narrow desktops. Clickable to configure execution target & workdir. */
function CodeHeader(ctx: PanelContext) {
  const [open, setOpen] = useState(false);
  const facts = codeFacts(ctx);
  if (!facts) return null;
  return (
    <>
      <ControlTrigger
        type="button"
        controlWidth="content"
        controlSize="compact"
        onClick={() => setOpen(true)}
        selected={open}
        className="hidden min-w-0 items-center gap-2 text-compact lg:inline-flex hover:text-content-strong"
        title={`${facts.repository} · ${facts.branch} · ${facts.state} — Configure repository & execution target`}
        aria-label="Configure repository & execution target"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <GitFork className="h-3.5 w-3.5 shrink-0 text-content-muted" aria-hidden="true" />
        <span className="max-w-48 truncate text-content-secondary">{facts.repository}</span>
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-content-muted" aria-hidden="true" />
        <span className="max-w-28 truncate">{facts.branch}</span>
        <span className={stateTone(facts.state)}>{facts.state}</span>
      </ControlTrigger>
      <ExecutionTargetDialog ctx={ctx} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Lane: the full board — source, execution target, branch, and head commit. */
function CodeBoard(ctx: PanelContext) {
  const [open, setOpen] = useState(false);
  const facts = codeFacts(ctx);
  if (!facts) return null;
  return (
    <PanelShell title="Code" icon={GitFork}>
      <div className="space-y-4 p-4 text-regular">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-compact text-content-muted">Repository &amp; Working directory</div>
            <div className="mt-1 font-medium text-content-primary truncate">{facts.repository}</div>
          </div>
          <Button
            action="switch"
            content="iconText"
            variant="secondary"
            controlSize="compact"
            onClick={() => setOpen(true)}
            title="Configure repository and working directory"
          >
            <Folder />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-content-secondary">
          <GitBranch className="h-4 w-4 text-content-muted" aria-hidden="true" /> {facts.branch}
        </div>
        <div className="flex items-center gap-2 text-content-secondary">
          <GitCommitHorizontal className="h-4 w-4 text-content-muted" aria-hidden="true" />
          {facts.head ? <code>{facts.head.slice(0, 12)}</code> : "No workspace commit reported"}
        </div>
        <div className="border-t border-zinc-800 pt-3 text-compact text-content-muted">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <span className="block text-content-muted">Host execution target</span>
              <span className="text-content-secondary truncate block mt-1">
                {facts.target ?? "Not configured"}
                {facts.targetOnline === false && <span className="ml-2 text-warning-400">Offline</span>}
              </span>
            </div>
            <Button
              action="setup"
              content="iconText"
              variant="secondary"
              controlSize="compact"
              onClick={() => setOpen(true)}
              title="Configure execution target"
            >
              <Server />
            </Button>
          </div>
        </div>
      </div>
      <ExecutionTargetDialog ctx={ctx} open={open} onClose={() => setOpen(false)} />
    </PanelShell>
  );
}

registerPanel({
  id: "official.github-code.header",
  title: "Code",
  icon: GitFork,
  surface: "header",
  profiles: ["code"],
  render: CodeHeader,
});

registerPanel({
  id: "github-code",
  title: "Code",
  icon: GitFork,
  surface: "lane",
  profiles: ["code"],
  render: CodeBoard,
});
