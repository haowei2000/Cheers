import { GitBranch, GitCommitHorizontal, GitFork, RefreshCw } from "lucide-react";
import toast from "react-hot-toast";
import { initializeChannelIntegration } from "@/api/integrations";
import { IconButton } from "@/components/ui/icon-button";
import { registerPanel, type PanelContext } from "../registry";
import { PanelShell } from "../defineResourcePanel";

// The `code` profile's status, on all three surfaces it appears on. Before the panels
// refactor this lived in three files against three registries and three context types
// (extensions/githubCode.tsx, panels/GitHubCodePanel.tsx, panels/GitHubCodeWorkbenchPanel.tsx),
// each re-deriving the same four fields from the same ChannelProfile. The presentations
// genuinely differ — a header chip, a lane card, a Workbench status strip — but the facts
// do not, so they are read once here.

interface CodeFacts {
  repository: string;
  branch: string;
  state: string;
  head: string | null;
  workspace: string | null;
  lastError: string | null;
}

/** Read the `code` profile's facts. The profile is capability-filtered by the gateway and
 *  never carries OAuth or App installation credentials — see docs/arch/PLUGIN_SYSTEM.md. */
function codeFacts(ctx: PanelContext): CodeFacts | null {
  const profile = ctx.profile;
  if (!profile) return null;
  const str = (value: unknown, fallback: string | null) =>
    typeof value === "string" ? value : fallback;
  return {
    repository: str(profile.config.repository, "Repository") as string,
    branch: str(profile.config.branch, "main") as string,
    state: str(profile.status.state, "pending") as string,
    head: str(profile.status.head_commit, null),
    workspace: str(profile.status.workspace_path, null),
    lastError: str(profile.status.last_error, null),
  };
}

function stateTone(state: string): string {
  if (state === "ready") return "text-success-400";
  if (state === "error") return "text-danger-400";
  return "text-warning-400";
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

/** Lane: the full board — repository, branch, head commit, workspace path. */
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
          Workspace: {facts.workspace ?? facts.state}
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
        {(facts.state === "error" || facts.state === "pending") && (
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
