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
    <Modal open={open} onClose={onClose} title="创建频道">
      <div className="space-y-4">
        <div>
          <label
            className="block text-sm font-medium mb-1"
            style={{ color: "var(--fg-2)" }}
          >
            工作空间
          </label>
          <select
            value={selectedWorkspaceId}
            onChange={(e) => onSelectWorkspace(e.target.value)}
            className="an-select"
          >
            <option value="">选择工作空间</option>
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
            频道名称
          </label>
          <input
            type="text"
            value={channelName}
            onChange={(e) => onChannelNameChange(e.target.value)}
            placeholder="输入频道名称"
            className="an-input"
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          />
        </div>
        <ModalFooter>
          <button type="button" onClick={onClose} className="an-btn an-btn-ghost">
            取消
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className="an-btn an-btn-primary"
          >
            创建
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
