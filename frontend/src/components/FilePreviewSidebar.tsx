import { useEffect, useState } from "react";
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  DocumentIcon,
} from "@heroicons/react/24/solid";
import { MessageMarkdown } from "../MessageMarkdown";

export function FilePreviewSidebar({
  url,
  filename,
  onClose,
}: {
  url: string;
  filename: string;
  onClose: () => void;
}) {
  const downloadUrl = url.replace(/\/preview$/, "/download");
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const isMarkdown = ext === "md" || ext === "markdown";

  const [mdContent, setMdContent] = useState<string | null>(null);
  const [mdLoading, setMdLoading] = useState(false);
  const [mdError, setMdError] = useState<string | null>(null);

  useEffect(() => {
    if (!isMarkdown) return;
    setMdLoading(true);
    setMdContent(null);
    setMdError(null);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        setMdContent(text);
        setMdLoading(false);
      })
      .catch((e) => {
        setMdError(String(e));
        setMdLoading(false);
      });
  }, [url, isMarkdown]);

  return (
    <aside className="w-full border-l border-gray-200 bg-white flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-100 flex-shrink-0">
        <div className="w-7 h-7 rounded-md bg-blue-50 flex items-center justify-center flex-shrink-0">
          <DocumentIcon className="w-4 h-4 text-blue-500" />
        </div>
        <span className="text-sm font-semibold text-gray-900 truncate flex-1 min-w-0">
          {filename}
        </span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <a
            href={downloadUrl}
            download={filename}
            className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="下载文件"
          >
            <ArrowDownTrayIcon className="w-4 h-4" />
          </a>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="在新标签页打开"
          >
            <ArrowTopRightOnSquareIcon className="w-4 h-4" />
          </a>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-base leading-none transition-colors"
            title="关闭"
          >
            ×
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isMarkdown ? (
          mdLoading ? (
            <div className="flex items-center justify-center h-full text-sm text-gray-400">
              加载中…
            </div>
          ) : mdError ? (
            <div className="flex items-center justify-center h-full text-sm text-red-400">
              {mdError}
            </div>
          ) : (
            <div className="px-5 py-4">
              <MessageMarkdown text={mdContent ?? ""} />
            </div>
          )
        ) : (
          <iframe
            key={url}
            src={url}
            title={filename}
            className="w-full h-full border-0"
          />
        )}
      </div>
    </aside>
  );
}
