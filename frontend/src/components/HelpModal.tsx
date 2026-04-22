interface HelpModalProps {
  open: boolean;
  onClose: () => void;
  apiDocsUrl: string;
}

export function HelpModal({ open, onClose, apiDocsUrl }: HelpModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6 text-left max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-gray-900">使用帮助</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <p className="text-gray-700 text-sm mb-3">
          在任意频道输入 <strong>@channel bot</strong> 并输入你的问题，channel bot
          会根据说明书自动回复，并显示相关入口。
        </p>
        <p className="text-gray-600 text-xs mb-2">例如可以问：</p>
        <ul className="text-sm text-gray-700 space-y-1 list-disc list-inside mb-2">
          <li>@channel bot 怎么用</li>
          <li>@channel bot 怎么创建项目</li>
          <li>@channel bot 怎么加入项目</li>
          <li>@channel bot 怎么接入 OpenClaw</li>
          <li>@channel bot 入口</li>
        </ul>
        <p className="text-gray-600 text-xs mb-2">前端入口：</p>
        <ul className="text-sm text-gray-700 space-y-1 list-disc list-inside mb-4">
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
              className="text-[#1264A3] underline"
            >
              /docs
            </a>
          </li>
        </ul>
        <p className="text-gray-500 text-xs">完整说明见项目文档。</p>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-[#F8F8F8] text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
