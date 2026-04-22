import { useState } from "react";
import { MessageMarkdown } from "../MessageMarkdown";

const THINK_BLOCK = /<think>([\s\S]*?)<\/think>/gi;

export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function ThinkFold({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded border border-gray-200 bg-gray-50 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2 py-1 text-left text-gray-400 hover:bg-gray-100 flex items-center gap-1"
      >
        <span
          className="inline-block transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          ▶
        </span>
        <span>
          {"<think> "}
          {open ? "收起" : "展开"}
        </span>
      </button>
      {open && (
        <pre className="p-2 text-xs text-gray-500 whitespace-pre-wrap border-t border-gray-100 max-h-48 overflow-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

/** 将内容中的 <think>...</think> 替换为可折叠块，返回用于渲染的 React 节点数组 */
export function renderWithThinkFolding(
  content: string,
  keyPrefix = "",
  streaming?: boolean,
  onImageClick?: (src: string) => void,
  onFileClick?: (url: string, filename: string) => void,
): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  THINK_BLOCK.lastIndex = 0;
  while ((match = THINK_BLOCK.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const seg = content.slice(lastIndex, match.index).replace(/\n/g, "  \n");
      parts.push(
        <MessageMarkdown
          key={`${keyPrefix}seg-${key++}`}
          text={seg}
          streaming={streaming}
          onImageClick={onImageClick}
          onFileClick={onFileClick}
        />,
      );
    }
    const thinkContent = match[1]?.trim() || "";
    parts.push(
      <ThinkFold key={`${keyPrefix}think-${key++}`} content={thinkContent} />,
    );
    lastIndex = THINK_BLOCK.lastIndex;
  }
  if (lastIndex < content.length) {
    const seg = content.slice(lastIndex).replace(/\n/g, "  \n");
    parts.push(
      <MessageMarkdown
        key={`${keyPrefix}tail-${key++}`}
        text={seg}
        streaming={streaming}
        onImageClick={onImageClick}
        onFileClick={onFileClick}
      />,
    );
  }
  if (parts.length === 0) {
    const seg = content.replace(/\n/g, "  \n");
    parts.push(
      <MessageMarkdown
        key={`${keyPrefix}full-0`}
        text={seg}
        streaming={streaming}
        onImageClick={onImageClick}
        onFileClick={onFileClick}
      />,
    );
  }
  return parts;
}
