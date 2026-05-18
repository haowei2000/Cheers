import { useEffect, useMemo, useState } from "react";
import type { SearchSelection } from "../types";
import type { Workspace } from "../types";
import { AppIcon } from "./icons/AppIcon";
import { Modal, ModalFooter } from "./Modal";
import { SearchPicker } from "./SearchPicker";
import { itemKey, labelFor, subFor } from "./search/searchResultUtils";

export type CreateChannelSubmitOptions = {
  type: "public" | "private";
  initialUserIds: string[];
  initialBotIds: string[];
};

interface CreateChannelModalProps {
  open: boolean;
  workspaces: Workspace[];
  selectedWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  channelName: string;
  onChannelNameChange: (name: string) => void;
  authToken?: string | null;
  onSubmit: (options: CreateChannelSubmitOptions) => void;
  onClose: () => void;
}

export function CreateChannelModal({
  open,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  channelName,
  onChannelNameChange,
  authToken,
  onSubmit,
  onClose,
}: CreateChannelModalProps) {
  const [channelType, setChannelType] = useState<"public" | "private">("public");
  const [selectedPeople, setSelectedPeople] = useState<SearchSelection[]>([]);

  useEffect(() => {
    if (!open) {
      setChannelType("public");
      setSelectedPeople([]);
    }
  }, [open]);

  useEffect(() => {
    setSelectedPeople([]);
  }, [selectedWorkspaceId]);

  const selectedIds = useMemo(() => {
    const initialUserIds: string[] = [];
    const initialBotIds: string[] = [];
    for (const selection of selectedPeople) {
      if (selection.type === "user") initialUserIds.push(selection.item.user_id);
      if (selection.type === "bot") initialBotIds.push(selection.item.bot_id);
    }
    return { initialUserIds, initialBotIds };
  }, [selectedPeople]);

  const addSelection = (selection: SearchSelection) => {
    if (selection.type !== "user" && selection.type !== "bot") return;
    setSelectedPeople((prev) => {
      const key = itemKey(selection);
      return prev.some((item) => itemKey(item) === key) ? prev : [...prev, selection];
    });
  };

  const removeSelection = (key: string) => {
    setSelectedPeople((prev) => prev.filter((selection) => itemKey(selection) !== key));
  };

  const submit = () => {
    onSubmit({
      type: channelType,
      initialUserIds: selectedIds.initialUserIds,
      initialBotIds: selectedIds.initialBotIds,
    });
  };

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
            Channel scope
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(["public", "private"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => setChannelType(scope)}
                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  channelType === scope
                    ? "border-[#1264A3] bg-blue-50 text-[#1264A3]"
                    : "border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                <div className="font-medium">
                  {scope === "public" ? "Workspace" : "Private"}
                </div>
                <div className="text-xs text-gray-500">
                  {scope === "public" ? "Workspace members" : "Selected members"}
                </div>
              </button>
            ))}
          </div>
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
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <div>
          <label
            className="block text-sm font-medium mb-1"
            style={{ color: "var(--fg-2)" }}
          >
            Initial members and bots
          </label>
          <SearchPicker
            context="channel_create"
            token={authToken}
            workspaceId={selectedWorkspaceId || undefined}
            types={["users", "bots"]}
            limit={8}
            modal
            showInitialResults
            placeholder="Search or choose users and bots"
            emptyText={selectedWorkspaceId ? "No users or bots available" : "Select workspace first"}
            actionLabel={(selection) => {
              if (selection.type !== "user" && selection.type !== "bot") return null;
              return selectedPeople.some((item) => itemKey(item) === itemKey(selection))
                ? "Selected"
                : "Add";
            }}
            onSelect={addSelection}
          />
          {selectedPeople.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {selectedPeople.map((selection) => {
                const key = itemKey(selection);
                return (
                  <span
                    key={key}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                    style={{ borderColor: "var(--border)", color: "var(--fg-2)" }}
                    title={subFor(selection)}
                  >
                    <span
                      className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[10px]"
                      style={{ background: "var(--bg-2)", color: "var(--fg-3)" }}
                    >
                      {selection.type === "bot" ? "B" : "U"}
                    </span>
                    <span className="truncate">{labelFor(selection)}</span>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-black/5"
                      onClick={() => removeSelection(key)}
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
          <button type="button" onClick={onClose} className="an-btn an-btn-ghost">
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
