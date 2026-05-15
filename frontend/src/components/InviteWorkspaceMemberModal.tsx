import { Modal, ModalFooter } from "./Modal";
import { SearchPicker } from "./SearchPicker";

interface InviteWorkspaceMemberModalProps {
  open: boolean;
  value: string;
  authToken?: string | null;
  workspaceId?: string | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPickUser: (userId: string) => void;
  onClose: () => void;
}

export function InviteWorkspaceMemberModal({
  open,
  value,
  authToken,
  workspaceId,
  onChange,
  onSubmit,
  onPickUser,
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
          <div style={{ marginTop: 10 }}>
            <SearchPicker
              context="workspace_invite"
              token={authToken}
              workspaceId={workspaceId || undefined}
              types={["users"]}
              modal
              placeholder="搜索用户"
              actionLabel="邀请"
              onSelect={(selection) => {
                if (selection.type === "user") onPickUser(selection.item.user_id);
              }}
            />
          </div>
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
