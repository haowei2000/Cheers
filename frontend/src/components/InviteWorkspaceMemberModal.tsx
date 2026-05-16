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
      title="Invite members"
      description="Invited members will automatically join all channels in this workspace."
    >
      <div className="space-y-4">
        <div>
          <label
            className="block text-sm font-medium mb-1"
            style={{ color: "var(--fg-2)" }}
          >
            Username
          </label>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter username"
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
              placeholder="Search users"
              actionLabel="Invite"
              onSelect={(selection) => {
                if (selection.type === "user") onPickUser(selection.item.user_id);
              }}
            />
          </div>
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
            Invite
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
