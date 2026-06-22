import { memo } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { Avatar } from "@/components/ui/avatar";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { apiFetch } from "@/api/client";
import type { Message, FileInfo } from "@/types";

interface Props {
  message: Message;
  isConsecutive?: boolean;
  currentUserId?: string;
}

const SYSTEM_TYPES = new Set([
  "routing",
  "permission",
  "announcement",
  "notification",
]);

function SystemMessage({ message }: { message: Message }) {
  return (
    <div className="flex items-center gap-3 py-1 px-4">
      <div className="flex-1 h-px bg-zinc-800" />
      <span className="text-xs text-zinc-500 whitespace-nowrap">
        {message.content}
      </span>
      <div className="flex-1 h-px bg-zinc-800" />
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  isConsecutive,
  currentUserId,
}: Props) {
  if (message.is_deleted) {
    return (
      <div className="px-4 py-0.5 flex items-center gap-3 group">
        {!isConsecutive && <div className="w-9 h-9 flex-shrink-0" />}
        {isConsecutive && <div className="w-9 flex-shrink-0" />}
        <span className="text-zinc-600 italic text-sm">
          This message was deleted
        </span>
      </div>
    );
  }

  if (message.msg_type && SYSTEM_TYPES.has(message.msg_type)) {
    return <SystemMessage message={message} />;
  }

  const isOwn = message.sender_id === currentUserId;
  const name = message.sender_name || message.sender_id.slice(0, 8);
  const isBot = message.sender_type === "bot";

  if (isConsecutive) {
    return (
      <div className="group flex items-start gap-3 px-4 py-0.5 hover:bg-zinc-900/40 transition-colors">
        <div className="w-9 flex-shrink-0 flex items-center justify-end pt-1">
          <span className="text-[10px] text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity select-none">
            {formatTime(message.created_at)}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <MessageBody message={message} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-start gap-3 px-4 py-1.5 hover:bg-zinc-900/40 transition-colors",
        isOwn && "flex-row-reverse"
      )}
    >
      {/* Avatar */}
      <Avatar
        name={name}
        src={undefined}
        id={message.sender_id}
        size="sm"
        className="mt-0.5 flex-shrink-0"
      />

      <div className={cn("flex-1 min-w-0", isOwn && "flex flex-col items-end")}>
        {/* Header */}
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className={cn("text-sm font-semibold text-zinc-100", isOwn && "order-2")}>
            {name}
          </span>
          {isBot && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300 font-medium">
              BOT
            </span>
          )}
          <span className="text-[11px] text-zinc-600 tabular-nums">
            {formatTime(message.created_at)}
          </span>
        </div>

        {/* Body */}
        <MessageBody message={message} />
      </div>
    </div>
  );
});

// Flat <#file:id> tokens render as chips (below), not inline text.
const FILE_TOKEN = /<#file:[^>]+>/g;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadFile(file: FileInfo) {
  // The download endpoint is JWT-protected, so fetch with auth then save a blob.
  try {
    const res = await apiFetch(`/files/${file.file_id}/download`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.original_filename || file.file_id;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    /* ignore download failures */
  }
}

function FileChips({ files }: { files: FileInfo[] }) {
  if (!files.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {files.map((f) => (
        <button
          key={f.file_id}
          type="button"
          onClick={() => downloadFile(f)}
          title={f.original_filename || f.file_id}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 transition-colors max-w-[240px]"
        >
          <FileText className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
          <span className="truncate">{f.original_filename || "file"}</span>
          {typeof f.size_bytes === "number" && (
            <span className="text-zinc-500">{formatBytes(f.size_bytes)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function MessageBody({ message }: { message: Message }) {
  const files = message.files ?? [];
  const content = (message.content ?? "").replace(FILE_TOKEN, "").trim();

  if (message._streaming && !content && files.length === 0) {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
        </div>
        {message._trace && (
          <span className="text-xs text-zinc-500 italic truncate">
            {message._trace}
          </span>
        )}
      </div>
    );
  }

  if (message.error) {
    return <p className="text-sm text-red-400 italic">{message.error}</p>;
  }

  const hasMarkdown =
    content.includes("```") ||
    content.includes("**") ||
    content.includes("*") ||
    content.includes("#") ||
    content.includes("[") ||
    content.includes("\n") ||
    content.includes("`");

  return (
    <div className="relative">
      {content &&
        (hasMarkdown ? (
          <MarkdownRenderer content={content} className="text-sm" />
        ) : (
          <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </p>
        ))}
      {message._streaming && (
        <span className="inline-block w-0.5 h-4 bg-zinc-400 animate-blink ml-0.5 align-text-bottom" />
      )}
      {message._streaming && message._trace && (
        <p className="text-xs text-zinc-500 italic mt-0.5">{message._trace}</p>
      )}
      <FileChips files={files} />
    </div>
  );
}
