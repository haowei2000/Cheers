import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/notify";

/** Shared discovery feedback for bot defaults and per-session controls. */
export function AgentOptionsFeedback({ loading = false, error, onRetry }: {
  loading?: boolean;
  error?: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" role={error ? "alert" : "status"} aria-busy={loading}>
      <span className={error ? "text-regular text-danger-400" : "text-regular text-content-muted"}>
        {error ? `Could not load agent options. ${messageOf(error)}` : loading ? "Loading agent options…" : "No agent options available yet. They appear when the agent starts a session."}
      </span>
      {!loading && <Button action="retry" variant="plain" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
