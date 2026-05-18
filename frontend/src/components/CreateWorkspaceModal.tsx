import { useEffect, useMemo, useState } from "react";
import type { SearchSelection } from "../types";
import { AvatarIconPicker } from "./AvatarIconPicker";
import { AppIcon } from "./icons/AppIcon";
import { Modal, ModalFooter } from "./Modal";
import { SearchPicker } from "./SearchPicker";
import { itemKey, labelFor, subFor } from "./search/searchResultUtils";

export type CreateWorkspaceSubmitOptions = {
  initialMemberIds: string[];
};

interface CreateWorkspaceModalProps {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  authToken?: string | null;
  avatarUrl?: string;
  onAvatarUrlChange?: (value: string) => void;
  onSubmit: (options: CreateWorkspaceSubmitOptions) => void;
  onClose: () => void;
}

export function CreateWorkspaceModal({
  open,
  value,
  onChange,
  authToken,
  avatarUrl = "",
  onAvatarUrlChange,
  onSubmit,
  onClose,
}: CreateWorkspaceModalProps) {
  const [selectedMembers, setSelectedMembers] = useState<SearchSelection[]>([]);
  const selectedMemberIds = useMemo(
    () =>
      selectedMembers
        .filter((selection) => selection.type === "user")
        .map((selection) => selection.item.user_id),
    [selectedMembers],
  );

  useEffect(() => {
    if (!open) setSelectedMembers([]);
  }, [open]);

  const addMember = (selection: SearchSelection) => {
    if (selection.type !== "user") return;
    setSelectedMembers((prev) => {
      const key = itemKey(selection);
      return prev.some((item) => itemKey(item) === key) ? prev : [...prev, selection];
    });
  };

  const removeMember = (key: string) => {
    setSelectedMembers((prev) => prev.filter((selection) => itemKey(selection) !== key));
  };

  const submit = () => {
    onSubmit({ initialMemberIds: selectedMemberIds });
  };

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
            onKeyDown={(e) => e.key === "Enter" && submit()}
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
        <div>
          <label
            className="block text-sm font-medium mb-1"
            style={{ color: "var(--fg-2)" }}
          >
            Initial members
          </label>
          <SearchPicker
            context="workspace_create"
            token={authToken}
            types={["users"]}
            limit={8}
            modal
            showInitialResults
            placeholder="Search or choose users"
            emptyText="No users available"
            actionLabel={(selection) => {
              if (selection.type !== "user") return null;
              return selectedMembers.some((item) => itemKey(item) === itemKey(selection))
                ? "Selected"
                : "Add";
            }}
            onSelect={addMember}
          />
          {selectedMembers.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {selectedMembers.map((selection) => {
                const key = itemKey(selection);
                return (
                  <span
                    key={key}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                    style={{ borderColor: "var(--border)", color: "var(--fg-2)" }}
                    title={subFor(selection)}
                  >
                    <span className="truncate">{labelFor(selection)}</span>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-black/5"
                      onClick={() => removeMember(key)}
                      aria-label={`Remove ${labelFor(selection)}`}
                    >
                      <AppIcon name="close" className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
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
            onClick={submit}
            className="an-btn an-btn-primary"
          >
            Create
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
