import { useEffect, useRef, useState } from "react";
import { MessageMarkdown } from "../../../MessageMarkdown";

export function EntryEditor({
  initialTitle,
  initialContent,
  onSave,
  onCancel,
  saving,
}: {
  initialTitle: string;
  initialContent: string;
  onSave: (title: string, content: string) => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [previewMode, setPreviewMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="border border-blue-200 rounded-lg overflow-hidden bg-white shadow-sm">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          className="flex-1 text-sm font-medium bg-transparent border-none outline-none placeholder-gray-400"
        />
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          <button
            onClick={() => setPreviewMode(false)}
            className={`text-xs px-2 py-1 rounded ${!previewMode ? "bg-white shadow-sm text-gray-700" : "text-gray-400 hover:text-gray-600"}`}
          >
            Edit
          </button>
          <button
            onClick={() => setPreviewMode(true)}
            className={`text-xs px-2 py-1 rounded ${previewMode ? "bg-white shadow-sm text-gray-700" : "text-gray-400 hover:text-gray-600"}`}
          >
            Preview
          </button>
        </div>
      </div>
      <div className="min-h-[160px]">
        {previewMode ? (
          <div className="p-4 prose prose-sm max-w-none text-sm">
            {content.trim() ? (
              <MessageMarkdown text={content} />
            ) : (
              <p className="text-gray-400 italic">No content</p>
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Markdown is supported..."
            className="w-full min-h-[160px] p-4 text-sm font-mono leading-relaxed resize-y border-none outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                onSave(title, content);
            }}
          />
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-t border-gray-100">
        <span className="text-[11px] text-gray-400">Ctrl+Enter Save</span>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(title, content)}
            disabled={saving || !content.trim()}
            className="text-xs px-3 py-1.5 rounded bg-[#1264A3] text-white hover:bg-[#0f5a94] disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
