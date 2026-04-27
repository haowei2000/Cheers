interface HelpModalProps {
  open: boolean;
  onClose: () => void;
  apiDocsUrl: string;
}

export function HelpModal({ open, onClose, apiDocsUrl }: HelpModalProps) {
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
        className="rounded-xl max-w-md w-full mx-4 p-6 text-left max-h-[90vh] overflow-auto"
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
            使用帮助
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
        <p className="text-sm mb-3" style={{ color: "var(--fg-2)" }}>
          在任意频道输入 <strong>@Coordinator</strong> 并输入你的问题，Coordinator
          会根据说明书自动回复，并显示相关入口。
        </p>
        <p className="text-xs mb-2" style={{ color: "var(--fg-3)" }}>
          例如可以问：
        </p>
        <ul
          className="text-sm space-y-1 list-disc list-inside mb-2"
          style={{ color: "var(--fg-2)" }}
        >
          <li>@Coordinator 怎么用</li>
          <li>@Coordinator 怎么创建项目</li>
          <li>@Coordinator 怎么加入项目</li>
          <li>@Coordinator 怎么接入 OpenClaw</li>
          <li>@Coordinator 入口</li>
        </ul>
        <p className="text-xs mb-2" style={{ color: "var(--fg-3)" }}>
          前端入口：
        </p>
        <ul
          className="text-sm space-y-1 list-disc list-inside mb-4"
          style={{ color: "var(--fg-2)" }}
        >
          <li>
            创建项目、Bot、性能监控、日志排查：左侧 <strong>管理</strong> 进入管理页面
          </li>
          <li>
            上传文件：频道内输入框旁 <strong>上传</strong>
            （.txt/.md/.docx/.pdf/.xlsx/.png/.jpg 等）
          </li>
          <li>
            频道上下文：选中频道后点击 <strong>频道上下文</strong>
          </li>
          <li>
            API 文档：管理页内「打开 API 文档」或{" "}
            <a
              href={apiDocsUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
              style={{ color: "var(--accent)" }}
            >
              /docs
            </a>
          </li>
        </ul>
        <p className="text-xs" style={{ color: "var(--fg-3)" }}>
          完整说明见项目文档。
        </p>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="an-btn an-btn-ghost"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
