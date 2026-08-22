import { useEffect, useState } from "react";
import { GitBranch, GitCommitHorizontal, GitFork, RefreshCw, Server } from "lucide-react";
import toast from "react-hot-toast";
import { initializeChannelIntegration } from "@/api/integrations";
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
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/select";
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

function ExecutionTargetControl({ ctx, compact = false }: { ctx: PanelContext; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [hosts, setHosts] = useState<FleetHost[]>([]);
  const [hostId, setHostId] = useState("");
  const [repositories, setRepositories] = useState<HostRepository[]>([]);
  const [checkoutPath, setCheckoutPath] = useState("");
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
        checkoutPath ? { cwd: checkoutPath } : undefined,
      );
      await setPrimaryChannelBotSession(ctx.channelId, host.bot_id, session.session_id);
      await putCodeProfile(ctx.channelId, {
        remote_source: ctx.profile?.config.remote_source,
        execution_target: { bot_id: host.bot_id, host_id: host.host_id },
      });
      toast.success("Execution target updated");
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update execution target");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {compact ? (
        <IconButton controlSize="compact" onClick={() => setOpen(true)} label="Configure execution target">
          <Server className="h-3.5 w-3.5" />
        </IconButton>
      ) : (
        <Button action="setup" content="iconText" variant="secondary" controlSize="compact" onClick={() => setOpen(true)}>
          <Server />
        </Button>
      )}
      {open && (
        <Dialog title="Execution target" onClose={() => setOpen(false)}>
          <div className="space-y-2">
            <span className="block text-compact text-content-muted">Bot Host</span>
            <Select aria-label="Bot Host" controlSize="regular" value={hostId}
              onChange={(event) => setHostId(event.target.value)}>
              <option value="">No online Hosts</option>
              {hosts.map((host) => (
                <option key={host.host_id} value={host.host_id}>
                  {host.bot_name} · {host.device_name}
                </option>
              ))}
            </Select>
            {repositories.length > 0 && (
              <>
                <span className="block text-compact text-content-muted">Repository checkout</span>
                <Select aria-label="Repository checkout" controlSize="regular" value={checkoutPath}
                  onChange={(event) => setCheckoutPath(event.target.value)}>
                  {repositories.map((repository) => (
                    <option key={repository.path} value={repository.path}>
                      {repository.path}{repository.branch ? ` · ${repository.branch}` : ""}
                    </option>
                  ))}
                </Select>
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <ActionButton action="cancel" context="dialog" onClick={() => setOpen(false)} />
            <ActionButton action="save" context="form" loading={saving} disabled={!hostId || saving}
              onClick={() => void save()} />
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Header: a compact chip beside the channel title. Hidden below `lg` — the header has
 *  no room for it on narrow desktops. */
function CodeHeader(ctx: PanelContext) {
  const facts = codeFacts(ctx);
  if (!facts) return null;
  return (
    <div
      className="hidden min-w-0 items-center gap-2 text-compact text-content-muted lg:flex"
      title={`${facts.repository} · ${facts.branch} · ${facts.state}`}
    >
      <GitFork className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="max-w-48 truncate text-content-secondary">{facts.repository}</span>
      <GitBranch className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="max-w-28 truncate">{facts.branch}</span>
      <span className={stateTone(facts.state)}>{facts.state}</span>
    </div>
  );
}

/** Lane: the full board — source, execution target, branch, and head commit. */
function CodeBoard(ctx: PanelContext) {
  const facts = codeFacts(ctx);
  if (!facts) return null;
  return (
    <PanelShell title="Code" icon={GitFork}>
      <div className="space-y-4 p-4 text-regular">
        <div>
          <div className="text-compact text-content-muted">Repository</div>
          <div className="mt-1 font-medium text-content-primary">{facts.repository}</div>
        </div>
        <div className="flex items-center gap-2 text-content-secondary">
          <GitBranch className="h-4 w-4" aria-hidden="true" /> {facts.branch}
        </div>
        <div className="flex items-center gap-2 text-content-secondary">
          <GitCommitHorizontal className="h-4 w-4" aria-hidden="true" />
          {facts.head ? <code>{facts.head.slice(0, 12)}</code> : "No workspace commit reported"}
        </div>
        <div className="border-t border-zinc-800 pt-3 text-compact text-content-muted">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              Execution target: {facts.target ?? "Not configured"}
              {facts.targetOnline === false && <span className="ml-2 text-warning-400">Offline</span>}
            </span>
            <ExecutionTargetControl ctx={ctx} />
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

/** Workbench: a one-line status strip above the scene content, with the import retry —
 *  the only surface that offers an action, because it is the one you are on when a
 *  clone or checkout has failed. */
function CodeWorkspaceStrip(ctx: PanelContext) {
  const facts = codeFacts(ctx);
  if (!facts) return null;

  async function retryImport() {
    try {
      await initializeChannelIntegration(ctx.channelId);
      toast.success("Repository import requested");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Repository import failed");
    }
  }

  return (
    <section
      className="border-b border-zinc-800 bg-zinc-950/60 px-3 py-2"
      aria-label="Code workspace status"
    >
      <div className="flex min-w-0 items-center gap-3 text-compact">
        <GitFork className="h-4 w-4 shrink-0 text-content-muted" />
        <span className="min-w-0 truncate font-medium text-content-primary">{facts.repository}</span>
        <span className="inline-flex min-w-0 items-center gap-1 text-content-muted">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{facts.branch}</span>
        </span>
        {facts.head && (
          <span className="inline-flex items-center gap-1 font-code text-content-muted">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            {facts.head.slice(0, 8)}
          </span>
        )}
        <span className="ml-auto shrink-0 capitalize text-content-secondary">{facts.state}</span>
        <ExecutionTargetControl ctx={ctx} compact />
        {facts.hasRemoteSource && (facts.state === "error" || facts.state === "pending") && (
          <IconButton
            controlSize="compact"
            onClick={() => void retryImport()}
            label="Retry repository import"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {facts.lastError && (
        <p className="mt-1 truncate text-minimal text-danger-400">{facts.lastError}</p>
      )}
    </section>
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

registerPanel({
  id: "official.github.code.workspace",
  title: "Code workspace",
  icon: GitFork,
  surface: "inline",
  profiles: ["code"],
  render: CodeWorkspaceStrip,
});
