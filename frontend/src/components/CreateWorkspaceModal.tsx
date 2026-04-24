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
          <h2
            className="text-lg font-bold"
            style={{ color: "var(--fg-1)" }}
          >
            创建工作空间
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-xl leading-none transition-colors"
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
              名称
            </label>
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="输入工作空间名称"
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
