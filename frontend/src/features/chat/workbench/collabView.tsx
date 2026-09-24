import { Users } from "lucide-react";
import type { CollaboratorInfo } from "./collab";
import type { FileSessionConflict } from "./jsonFile";
import { Button } from "@/components/ui/button";
import { PresenceDot } from "@/components/ui/presence-dot";

export function CollaboratorPills({
  collaborators,
}: {
  collaborators: readonly CollaboratorInfo[];
}) {
  if (!collaborators || collaborators.length <= 1) return null;

  return (
    <div
      className="inline-flex items-center gap-1 rounded-sm bg-panel/80 px-2 py-1 text-compact text-content-muted ring-1 ring-inset ring-control/40 select-none shadow-xs"
      title={collaborators.map((c) => c.name).join(", ")}
    >
      <PresenceDot contentSize="small" className="bg-emerald-500" />
      <Users className="h-3.5 w-3.5 text-content-muted" />
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
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning-500/30 bg-warning-500/10 px-3 py-1 text-compact text-warning-200">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-warning-400">⚠️ Collaboration Conflict</span>
        <span>
          A collaborator also modified this file ({conflict.conflictsCount} conflicting region{conflict.conflictsCount > 1 ? "s" : ""}).
        </span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          controlSize="compact"
          variant="secondary"
          action="replace"
          onClick={() => onResolve("local")}
          title="Keep your edits and overwrite remote changes"
        >
          Keep Mine
        </Button>
        <Button
          controlSize="compact"
          variant="secondary"
          action="accept"
          onClick={() => onResolve("remote")}
          title="Discard your uncommitted edits and accept incoming changes"
        >
          Accept Incoming
        </Button>
        <Button
          controlSize="compact"
          variant="primary"
          action="resolve"
          onClick={() => onResolve("merged")}
          title="Insert standard diff conflict markers into the document to resolve manually in editor"
        >
          Merge with Markers
        </Button>
      </div>
    </div>
  );
}
