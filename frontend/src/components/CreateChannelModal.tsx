import type { Workspace } from "../types";

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
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      style={{ background: "var(--overlay)" }}
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="rounded-xl max-w-md w-full mx-4 p-6 text-left"
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
          color: "var(--fg-1)",
          boxShadow: "0 30px 80px var(--shadow)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold" style={{ color: "var(--fg-1)" }}>
            创建频道
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-xl leading-none"
            style={{ color: "var(--fg-3)" }}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
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
          <div className="flex justify-end gap-2">
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
          </div>
        </div>
      </div>
    </div>
  );
}
