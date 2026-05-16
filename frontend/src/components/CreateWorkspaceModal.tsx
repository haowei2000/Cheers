import { AvatarIconPicker } from "./AvatarIconPicker";
import { Modal, ModalFooter } from "./Modal";

interface CreateWorkspaceModalProps {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  avatarUrl?: string;
  onAvatarUrlChange?: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function CreateWorkspaceModal({
  open,
  value,
  onChange,
  avatarUrl = "",
  onAvatarUrlChange,
  onSubmit,
  onClose,
}: CreateWorkspaceModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Create workspace">
      <div className="space-y-4">
        <div>
          <label
            className="block text-sm font-medium mb-1"
            style={{ color: "var(--fg-2)" }}
          >
            Name
          </label>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter workspace name"
            className="an-input"
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            autoFocus
          />
        </div>
        {onAvatarUrlChange && (
          <div>
            <label
              className="block text-sm font-medium mb-1"
              style={{ color: "var(--fg-2)" }}
            >
              Icon
            </label>
            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={avatarUrl}
                onChange={(e) => onAvatarUrlChange(e.target.value)}
                placeholder="Icon URL or choose a built-in icon"
                className="an-input"
              />
              <AvatarIconPicker
                group="workspace"
                onChange={onAvatarUrlChange}
                value={avatarUrl}
              />
            </div>
          </div>
        )}
        <ModalFooter>
          <button
            type="button"
            onClick={onClose}
            className="an-btn an-btn-ghost"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className="an-btn an-btn-primary"
          >
            created
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
