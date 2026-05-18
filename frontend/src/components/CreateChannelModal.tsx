import type { Workspace } from "../types";
import { Modal, ModalFooter } from "./Modal";

interface CreateChannelModalProps {
  open: boolean;
  workspaces: Workspace[];
  selectedWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  channelName: string;
  onChannelNameChange: (name: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function CreateChannelModal({
  open,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  channelName,
  onChannelNameChange,
  onSubmit,
  onClose,
}: CreateChannelModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Create channel">
      <div className="space-y-4">
        <div>
          <label
            className="block text-sm font-medium mb-1"
            style={{ color: "var(--fg-2)" }}
          >
            Workspaces
          </label>
          <select
            value={selectedWorkspaceId}
            onChange={(e) => onSelectWorkspace(e.target.value)}
            className="an-select"
          >
            <option value="">Select workspace</option>
            {workspaces.map((w) => (
              <option key={w.workspace_id} value={w.workspace_id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            className="block text-sm font-medium mb-1"
            style={{ color: "var(--fg-2)" }}
          >
            Channel name
          </label>
          <input
            type="text"
            value={channelName}
            onChange={(e) => onChannelNameChange(e.target.value)}
            placeholder="Enter channel name"
            className="an-input"
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          />
        </div>
        <ModalFooter>
          <button type="button" onClick={onClose} className="an-btn an-btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className="an-btn an-btn-primary"
          >
            Create
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
