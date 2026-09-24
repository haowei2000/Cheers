import { Users } from "lucide-react";
import type { CollaboratorInfo } from "./collab";
import type { FileSessionConflict } from "./jsonFile";
import { Button } from "@/components/ui/button";

export function CollaboratorPills({
  collaborators,
}: {
  collaborators: readonly CollaboratorInfo[];
}) {
  if (!collaborators || collaborators.length <= 1) return null;

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full bg-panel/80 px-2 py-0.5 text-compact text-content-muted border border-control/40 select-none shadow-xs"
      title={collaborators.map((c) => c.name).join(", ")}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <Users className="h-3 w-3 text-content-muted" />
      <span className="text-minimal font-medium">
        {collaborators.length} editing
      </span>
    </div>
  );
}

export function ConflictBanner({
  conflict,
  onResolve,
}: {
  conflict: FileSessionConflict | null;
  onResolve: (choice: "local" | "remote" | "merged") => void;
}) {
  if (!conflict) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning-500/30 bg-warning-500/10 px-3 py-1.5 text-compact text-warning-200">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-warning-400">⚠️ Collaboration Conflict</span>
        <span>
          A collaborator also modified this file ({conflict.conflictsCount} conflicting region{conflict.conflictsCount > 1 ? "s" : ""}).
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          controlSize="minimal"
          variant="secondary"
          className="h-6 px-2 text-minimal"
          onClick={() => onResolve("local")}
          title="Keep your edits and overwrite remote changes"
        >
          Keep Mine
        </Button>
        <Button
          controlSize="minimal"
          variant="secondary"
          className="h-6 px-2 text-minimal"
          onClick={() => onResolve("remote")}
          title="Discard your uncommitted edits and accept incoming changes"
        >
          Accept Incoming
        </Button>
        <Button
          controlSize="minimal"
          variant="primary"
          className="h-6 px-2 text-minimal"
          onClick={() => onResolve("merged")}
          title="Insert standard diff conflict markers into the document to resolve manually in editor"
        >
          Merge with Markers
        </Button>
      </div>
    </div>
  );
}
