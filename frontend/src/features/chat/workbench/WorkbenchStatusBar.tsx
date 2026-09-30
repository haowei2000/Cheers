import { memo } from "react";
import type { CollaboratorInfo } from "./collab";
import { CollaboratorPills } from "./collabView";

export interface WorkbenchStatusBarProps {
  selectedPath: string | null;
  dirty?: boolean;
  saving?: boolean;
  parseError?: string | null;
  collaborators?: readonly CollaboratorInfo[];
  status?: string | null;
}

/**
 * Bottom status bar for the active Workbench item.
 * Displays file path, dirty state, parsing status, collaborator pills, and active status message.
 */
export const WorkbenchStatusBar = memo(function WorkbenchStatusBar({
  selectedPath,
  dirty = false,
  saving = false,
  parseError = null,
  collaborators = [],
  status = null,
}: WorkbenchStatusBarProps) {
  if (!selectedPath && !status && collaborators.length <= 1) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 border-t border-control/80 bg-panel px-3 py-1 text-compact">
      {selectedPath && (
        <span className="min-w-0 truncate text-content-muted" title={selectedPath}>
          {selectedPath}
        </span>
      )}
      {dirty && (
        <span className="flex-shrink-0 text-minimal text-warning-400" title="Unsaved changes">
          ●
        </span>
      )}
      {saving && (
        <span className="flex-shrink-0 text-minimal text-content-muted animate-pulse">
          Saving…
        </span>
      )}
      {parseError && (
        <span
          className="flex-shrink-0 text-minimal text-warning-400"
          title={`${parseError} — the preview is showing the last version that parsed`}
        >
          syntax error
        </span>
      )}
      <CollaboratorPills collaborators={collaborators} />
      {status && (
        <span className="min-w-0 flex-1 truncate text-right text-warning-300">
          {status}
        </span>
      )}
    </div>
  );
});
