import { Modal, ModalFooter } from "./Modal";

interface InviteWorkspaceMemberModalProps {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function InviteWorkspaceMemberModal({
  open,
  value,
  onChange,
  onSubmit,
  onClose,
}: InviteWorkspaceMemberModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="邀请成员"
      description="被邀请的成员将自动加入该工作空间下的所有频道。"
    >
      <div className="space-y-4">
        <div>
          <label
            className="block text-sm font-medium mb-1"
            style={{ color: "var(--fg-2)" }}
          >
            用户名
          </label>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="输入用户名"
            className="an-input"
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            autoFocus
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
            邀请
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
