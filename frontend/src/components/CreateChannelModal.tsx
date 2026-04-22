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
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6 text-left"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-gray-900">创建频道</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              工作空间
            </label>
            <select
              value={selectedWorkspaceId}
              onChange={(e) => onSelectWorkspace(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              频道名称
            </label>
            <input
              type="text"
              value={channelName}
              onChange={(e) => onChannelNameChange(e.target.value)}
              placeholder="输入频道名称"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
              onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onSubmit}
              className="px-4 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]"
            >
              创建
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
