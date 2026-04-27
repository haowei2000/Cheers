import { Modal, ModalFooter } from "./Modal";

interface CreateWorkspaceModalProps {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function CreateWorkspaceModal({
  open,
  value,
  onChange,
  onSubmit,
  onClose,
}: CreateWorkspaceModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="创建工作空间">
      <div className="space-y-4">
        <div>
          <label
            className="block text-sm font-medium mb-1"
            style={{ color: "var(--fg-2)" }}
          >
            名称
          </label>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="输入工作空间名称"
            className="an-input"
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            autoFocus
          />
        </div>
        <ModalFooter>
          <button
            type="button"
            onClick={onClose}
            className="an-btn an-btn-ghost"
          >
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
