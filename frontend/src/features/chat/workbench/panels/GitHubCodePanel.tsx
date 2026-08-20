import { GitBranch, GitCommitHorizontal, GitFork } from "lucide-react";
import { registerComponentViewBoard, ViewBoardShell, type ViewBoardContext } from "../viewBoard";

function GitHubCodePanel({ profile }: ViewBoardContext) {
  if (!profile) return null;
  const repository = typeof profile.config.repository === "string" ? profile.config.repository : "Repository";
  const branch = typeof profile.config.branch === "string" ? profile.config.branch : "main";
  const state = typeof profile.status.state === "string" ? profile.status.state : "pending";
  const head = typeof profile.status.head_commit === "string" ? profile.status.head_commit : null;
  const workspace = typeof profile.status.workspace_path === "string" ? profile.status.workspace_path : null;
  return (
    <ViewBoardShell title="Code" icon={GitFork}>
      <div className="space-y-4 p-4 text-regular">
        <div>
          <div className="text-compact text-content-muted">Repository</div>
          <div className="mt-1 font-medium text-content-primary">{repository}</div>
        </div>
        <div className="flex items-center gap-2 text-content-secondary">
          <GitBranch className="h-4 w-4" aria-hidden="true" /> {branch}
        </div>
        <div className="flex items-center gap-2 text-content-secondary">
          <GitCommitHorizontal className="h-4 w-4" aria-hidden="true" />
          {head ? <code>{head.slice(0, 12)}</code> : "No workspace commit reported"}
        </div>
        <div className="border-t border-zinc-800 pt-3 text-compact text-content-muted">
          Workspace: {workspace ?? state}
        </div>
      </div>
    </ViewBoardShell>
  );
}

registerComponentViewBoard({
  id: "github-code",
  title: "Code",
  icon: GitFork,
  profiles: ["code"],
  component: GitHubCodePanel,
});
