import { GitBranch, GitFork } from "lucide-react";
import { registerChannelHeader, type ChannelExtensionContext } from "./channelSlots";

function GitHubCodeHeader({ profile }: ChannelExtensionContext) {
  const repository = typeof profile.config.repository === "string" ? profile.config.repository : "Repository";
  const branch = typeof profile.config.branch === "string" ? profile.config.branch : "main";
  const state = typeof profile.status.state === "string" ? profile.status.state : "pending";
  return (
    <div className="hidden min-w-0 items-center gap-2 text-compact text-content-muted lg:flex" title={`${repository} · ${branch} · ${state}`}>
      <GitFork className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="max-w-48 truncate text-content-secondary">{repository}</span>
      <GitBranch className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="max-w-28 truncate">{branch}</span>
      <span className={state === "ready" ? "text-success-400" : state === "error" ? "text-danger-400" : "text-warning-400"}>
        {state}
      </span>
    </div>
  );
}

registerChannelHeader({
  id: "official.github-code.header",
  profiles: ["code"],
  component: GitHubCodeHeader,
});
