import { GitBranch, GitCommitHorizontal, GitFork, RefreshCw } from "lucide-react";
import toast from "react-hot-toast";
import { initializeChannelIntegration } from "@/api/integrations";
import type { WorkbenchContext } from "../context";
import { registerWorkbenchPanel } from "../workbenchPanels";
import { IconButton } from "@/components/ui/icon-button";

function GitHubCodeWorkbenchPanel({ ctx }: { ctx: WorkbenchContext }) {
  const config = ctx.profile?.config;
  const status = ctx.profile?.status;

  async function retryImport() {
    try {
      await initializeChannelIntegration(ctx.channelId);
      toast.success("Repository import requested");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Repository import failed");
    }
  }

  return (
    <section className="border-b border-zinc-800 bg-zinc-950/60 px-3 py-2" aria-label="Code workspace status">
      <div className="flex min-w-0 items-center gap-3 text-compact">
        <GitFork className="h-4 w-4 shrink-0 text-content-muted" />
        <span className="min-w-0 truncate font-medium text-content-primary">{config?.repository ?? "Repository"}</span>
        <span className="inline-flex min-w-0 items-center gap-1 text-content-muted">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{config?.branch ?? "main"}</span>
        </span>
        {status?.head_commit && (
          <span className="inline-flex items-center gap-1 font-code text-content-muted">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            {status.head_commit.slice(0, 8)}
          </span>
        )}
        <span className="ml-auto shrink-0 capitalize text-content-secondary">{status?.state ?? "pending"}</span>
        {(status?.state === "error" || status?.state === "pending") && (
          <IconButton
            controlSize="compact"
            onClick={() => void retryImport()}
            label="Retry repository import"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {status?.last_error && <p className="mt-1 truncate text-minimal text-danger-400">{status.last_error}</p>}
    </section>
  );
}

registerWorkbenchPanel({
  id: "official.github.code.workspace",
  profiles: ["code"],
  component: GitHubCodeWorkbenchPanel,
});
