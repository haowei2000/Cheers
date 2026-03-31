import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import FriendsPanel from "./FriendsPanel";
import ChannelMembersModal from "./ChannelMembersModal";
import { MessageMarkdown } from "./MessageMarkdown";

const API = "/api";
const WS_BASE = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const DEV_USER_ID = "a0000000-0000-0000-0000-000000000001";
const API_DOCS_URL = "/docs";

type Channel = { channel_id: string; name: string; type: string; workspace_id?: string; auto_assist?: boolean };
type Workspace = { workspace_id: string; name: string };
type FileInfo = {
  file_id: string;
  original_filename?: string;
  content_type?: string;
  size_bytes?: number;
  status?: string;
};
type Message = {
  msg_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
  created_at?: string;
  _streaming?: boolean;
  in_reply_to_msg_id?: string | null;
  file_ids?: string[];
  files?: FileInfo[];
  is_secret?: boolean;
  secret_token?: string;
};
type QaPair = { question: Message; answer: Message };
type ContextData = Record<string, string>;

const LAYERS = ["ANCHOR", "PROGRESS", "DECISIONS", "FILES_INDEX", "RECENT", "MEMBERS"] as const;

const GUIDE_FORM_BLOCK = /```guide-form\n([\s\S]*?)```/;
const GUIDE_CLARIFY_BLOCK = /```guide-clarify\n([\s\S]*?)```/;

type GuideFormField = {
  name: string;
  type: string;
  label: string;
  placeholder?: string;
  options_url?: string;
  option_value?: string;
  option_label?: string;
};

type GuideFormSchema = { action: string; fields: GuideFormField[] };

type ClarifyOption = { id: string; label: string; requires_text?: boolean; text_placeholder?: string };
type ClarifyQuestion = {
  id: string;
  prompt: string;
  allow_multiple?: boolean;
  options: ClarifyOption[];
  other_enabled?: boolean;
  other_label?: string;
  other_placeholder?: string;
};
type ClarifySchema = {
  title?: string;
  questions: ClarifyQuestion[];
  skip_policy?: "allow" | "forbid";
  reason?: string;
};
type ClarifyAnswers = {
  selected: Record<string, string[]>;
  other_text: Record<string, string>;
  option_text?: Record<string, string>; // key: `${q.id}:${opt.id}` for requires_text options
};
const OTHER_CHOICE_ID = "__other__";

function parseGuidePayload(content: string): { text: string; form?: GuideFormSchema; clarify?: ClarifySchema } {
  let text = content;
  let form: GuideFormSchema | undefined;
  let clarify: ClarifySchema | undefined;

  const formMatch = text.match(GUIDE_FORM_BLOCK);
  if (formMatch) {
    try {
      form = JSON.parse(formMatch[1].trim()) as GuideFormSchema;
      text = text.replace(formMatch[0], "");
    } catch {}
  }

  const clarifyMatch = text.match(GUIDE_CLARIFY_BLOCK);
  if (clarifyMatch) {
    try {
      const parsed = JSON.parse(clarifyMatch[1].trim()) as ClarifySchema;
      if (Array.isArray(parsed?.questions) && parsed.questions.length > 0) {
        clarify = parsed;
      }
      text = text.replace(clarifyMatch[0], "");
    } catch {}
  }

  return { text: text.trim(), form, clarify };
}



const THINK_BLOCK = /<think>([\s\S]*?)<\/think>/gi;

/** 将内容中的 <think>...</think> 替换为可折叠块，返回用于渲染的 React 节点数组 */
function renderWithThinkFolding(content: string, keyPrefix = "", streaming?: boolean, onImageClick?: (src: string) => void, onFileClick?: (url: string, filename: string) => void): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  THINK_BLOCK.lastIndex = 0;
  while ((match = THINK_BLOCK.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const seg = content.slice(lastIndex, match.index).replace(/\n/g, "  \n");
      parts.push(<MessageMarkdown key={`${keyPrefix}seg-${key++}`} text={seg} streaming={streaming} onImageClick={onImageClick} onFileClick={onFileClick} />);
    }
    const thinkContent = match[1]?.trim() || "";
    parts.push(
      <ThinkFold key={`${keyPrefix}think-${key++}`} content={thinkContent} />
    );
    lastIndex = THINK_BLOCK.lastIndex;
  }
  if (lastIndex < content.length) {
    const seg = content.slice(lastIndex).replace(/\n/g, "  \n");
    parts.push(<MessageMarkdown key={`${keyPrefix}tail-${key++}`} text={seg} streaming={streaming} onImageClick={onImageClick} onFileClick={onFileClick} />);
  }
  if (parts.length === 0) {
    const seg = content.replace(/\n/g, "  \n");
    parts.push(<MessageMarkdown key={`${keyPrefix}full-0`} text={seg} streaming={streaming} onImageClick={onImageClick} onFileClick={onFileClick} />);
  }
  return parts;
}

function ThinkFold({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded border border-gray-200 bg-gray-50 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2 py-1 text-left text-gray-400 hover:bg-gray-100 flex items-center gap-1"
      >
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <span>{"<think> "}{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <pre className="p-2 text-xs text-gray-500 whitespace-pre-wrap border-t border-gray-100 max-h-48 overflow-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

// ── Quote prefix helpers ──────────────────────────────────────────────────────
const QUOTE_PREFIX_RE = /^> \[([^\]]+)\]: ([\s\S]+?)\n\n([\s\S]*)$/;

function parseQuotePrefix(text: string): { label: string; quote: string; rest: string } | null {
  const m = QUOTE_PREFIX_RE.exec(text);
  if (!m) return null;
  return { label: m[1], quote: m[2], rest: m[3] };
}

// ── Resize handle hook ────────────────────────────────────────────────────────
function useResize(initialWidth: number, min: number, max: number, direction: "right" | "left" = "right") {
  const [width, setWidth] = useState(initialWidth);
  const widthRef = useRef(initialWidth);
  widthRef.current = width;
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      const delta = direction === "right" ? ev.clientX - startX : startX - ev.clientX;
      setWidth(Math.max(min, Math.min(max, startW + delta)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [direction, min, max]);
  return [width, onMouseDown] as const;
}

// ── File Preview Sidebar ──────────────────────────────────────────────────────
function FilePreviewSidebar({
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
      .then((text) => { setMdContent(text); setMdLoading(false); })
      .catch((e) => { setMdError(String(e)); setMdLoading(false); });
  }, [url, isMarkdown]);

  return (
    <aside className="w-full border-l border-gray-200 bg-white flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-100 flex-shrink-0">
        <div className="w-7 h-7 rounded-md bg-blue-50 flex items-center justify-center flex-shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-blue-500">
            <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 16 6.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
          </svg>
        </div>
        <span className="text-sm font-semibold text-gray-900 truncate flex-1 min-w-0">{filename}</span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <a
            href={downloadUrl}
            download={filename}
            className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="下载文件"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
              <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
            </svg>
          </a>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="在新标签页打开"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clipRule="evenodd" />
              <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clipRule="evenodd" />
            </svg>
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
            <div className="flex items-center justify-center h-full text-sm text-gray-400">加载中…</div>
          ) : mdError ? (
            <div className="flex items-center justify-center h-full text-sm text-red-400">{mdError}</div>
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

// ── Memory Panel (right sidebar) ─────────────────────────────────────────────
const LAYER_META: Record<string, { label: string; desc: string; color: string; icon: string; readonly?: boolean }> = {
  ANCHOR:      { label: "项目锚点",   desc: "核心目标、约束、背景",       color: "blue",   icon: "⚓" },
  PROGRESS:    { label: "项目进度",   desc: "当前进度、已完成、下一步",    color: "teal",   icon: "📈" },
  DECISIONS:   { label: "决策记录",   desc: "重要决策及原因",             color: "purple", icon: "📋" },
  FILES_INDEX: { label: "资料索引",   desc: "上传的文件与参考资料",        color: "amber",  icon: "🗂️" },
  RECENT:      { label: "近期动态",   desc: "最新进展、待办、结论",        color: "green",  icon: "🕐" },
  MEMBERS:     { label: "频道成员",   desc: "用户与 Bot 能力一览",        color: "gray",   icon: "👥", readonly: true },
};

type MemberItem = { member_id: string; member_type: string; username?: string; display_name?: string; avatar_url?: string };

function MemoryPanel({
  channelId,
  channelName,
  contextData,
  onSave,
  onDataChange,
  onClose,
}: {
  channelId: string;
  channelName: string;
  contextData: Record<string, string>;
  onSave: (layer: string, content: string) => void;
  onDataChange: (layer: string, val: string) => void;
  onClose: () => void;
}) {
  const [activeLayer, setActiveLayer] = useState<string>("ANCHOR");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [editVal, setEditVal] = useState("");
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const meta = LAYER_META[activeLayer];
  const isReadonly = !!meta.readonly;
  const rawContent = contextData[activeLayer.toLowerCase()] ?? "";
  const wordCount = rawContent.trim() ? rawContent.trim().split(/\s+/).length : 0;

  const switchLayer = (layer: string) => {
    setActiveLayer(layer);
    setMode("preview");
    setEditVal(contextData[layer.toLowerCase()] ?? "");
    if (layer === "MEMBERS") {
      setMembersLoading(true);
      fetch(`${API}/channels/${channelId}/members?with_username=1`)
        .then((r) => r.json())
        .then((d) => setMembers(d.data || []))
        .catch(() => {})
        .finally(() => setMembersLoading(false));
    }
  };

  // Load members on mount if starting on MEMBERS tab
  useEffect(() => {
    if (activeLayer === "MEMBERS") switchLayer("MEMBERS");
  }, []);

  const startEdit = () => {
    setEditVal(rawContent);
    setMode("edit");
  };

  const handleSave = () => {
    onDataChange(activeLayer, editVal);
    onSave(activeLayer, editVal);
    setMode("preview");
  };

  const handleDiscard = () => {
    setEditVal(rawContent);
    setMode("preview");
  };

  return (
    <aside className="w-full border-l border-gray-200 bg-white flex flex-col">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 flex-shrink-0">
        <div className="min-w-0">
          <span className="text-sm font-semibold text-gray-900">频道记忆</span>
          {channelName && (
            <span className="ml-1.5 text-xs text-gray-400">#{channelName}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-base leading-none flex-shrink-0"
          title="关闭"
        >
          ×
        </button>
      </div>

      {/* Layer tabs */}
      <div className="flex border-b border-gray-100 flex-shrink-0">
        {LAYERS.map((layer) => {
          const m = LAYER_META[layer];
          const active = layer === activeLayer;
          const filled = !!(contextData[layer.toLowerCase()]?.trim());
          return (
            <button
              key={layer}
              onClick={() => switchLayer(layer)}
              title={m.label}
              className={`flex-1 py-2 flex flex-col items-center gap-0.5 text-[10px] border-b-2 transition-colors ${
                active
                  ? "border-[#1264A3] text-[#1264A3]"
                  : "border-transparent text-gray-400 hover:text-gray-600 hover:bg-gray-50"
              }`}
            >
              <span className="text-sm leading-none">{m.icon}</span>
              <span className="leading-none font-medium truncate max-w-full px-0.5">{m.label.split(" ")[0]}</span>
              {filled && <span className="w-1 h-1 rounded-full bg-current opacity-60" />}
            </button>
          );
        })}
      </div>

      {/* Content toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-gray-700 truncate">{meta.label}</span>
          {!isReadonly && rawContent.trim() && (
            <span className="text-[10px] text-gray-400 flex-shrink-0">{wordCount}w</span>
          )}
          {isReadonly && (
            <span className="text-[10px] text-gray-400 flex-shrink-0">只读</span>
          )}
        </div>
        {!isReadonly && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {mode === "preview" ? (
              <button
                type="button"
                onClick={startEdit}
                className="text-[11px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
              >
                编辑
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleDiscard}
                  className="text-[11px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="text-[11px] px-2 py-1 rounded bg-[#1264A3] text-white hover:bg-[#0f5a94]"
                >
                  保存
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {isReadonly ? (
          membersLoading ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-xs">加载中…</div>
          ) : members.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 text-center px-4">
              <span className="text-3xl opacity-30">👥</span>
              <p className="text-xs text-gray-500">暂无成员</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {[...members]
                .sort((a, b) => (a.member_type === "bot" ? -1 : 1) - (b.member_type === "bot" ? -1 : 1))
                .map((m) => {
                  const isBot = m.member_type === "bot";
                  const label = m.display_name || m.username || (isBot ? "Bot" : "用户");
                  const sub = m.username && m.username !== m.display_name ? `@${m.username}` : null;
                  const initial = label.slice(0, 1).toUpperCase();
                  return (
                    <div key={m.member_id} className="flex items-center gap-2.5 px-3 py-2">
                      <div className={`w-7 h-7 rounded${isBot ? "" : "-full"} flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${isBot ? "bg-[#2EB67D]" : "bg-[#1264A3]"}`}>
                        {initial}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-gray-800 truncate">{label}</p>
                        {sub && <p className="text-[10px] text-gray-400 truncate">{sub}</p>}
                      </div>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${isBot ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-700"}`}>
                        {isBot ? "Bot" : "用户"}
                      </span>
                    </div>
                  );
                })}
            </div>
          )
        ) : mode === "edit" ? (
          <textarea
            value={editVal}
            onChange={(e) => setEditVal(e.target.value)}
            className="w-full h-full font-mono text-xs p-3 resize-none focus:outline-none leading-relaxed"
            placeholder={`用 Markdown 写 ${meta.label}…`}
            spellCheck={false}
          />
        ) : rawContent.trim() ? (
          <div className="px-3 py-3 text-sm">
            <MessageMarkdown text={rawContent} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 px-4 text-center">
            <span className="text-3xl opacity-30">{meta.icon}</span>
            <p className="text-xs font-medium text-gray-500">暂无内容</p>
            <p className="text-[11px] text-gray-400">{meta.desc}</p>
            <button
              type="button"
              onClick={startEdit}
              className="mt-1 text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
            >
              添加内容
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** 将消息按逻辑问答块分组（含 clarify 轮次），每个块以用户问题开头 */
function buildLogicalQaBlocks(messages: Message[]): { question: Message; messages: Message[] }[] {
  const blocks: { question: Message; messages: Message[] }[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.sender_type !== "user" || isClarifyReplyUserMessage(m.content)) {
      i++;
      continue;
    }
    const blockMessages: Message[] = [m];
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next.sender_type === "user" && !isClarifyReplyUserMessage(next.content)) {
        break;
      }
      blockMessages.push(next);
      j++;
    }
    blocks.push({ question: m, messages: blockMessages });
    i = j;
  }
  return blocks;
}

function formatTs(ts?: string): string {
  return (ts || "").slice(0, 19);
}

function buildQaMarkdown(channelName: string, pairs: QaPair[]): string {
  const now = new Date();
  const rows: string[] = [];
  rows.push(`# 问答导出 - ${channelName}`);
  rows.push("");
  rows.push(`导出时间: ${now.toISOString()}`);
  rows.push(`问答数量: ${pairs.length}`);
  rows.push("");
  pairs.forEach((p, idx) => {
    const qText = stripThinkTags(parseGuidePayload(p.question.content).text || p.question.content);
    const aText = stripThinkTags(parseGuidePayload(p.answer.content).text || p.answer.content);
    rows.push(`## ${idx + 1}. 问答`);
    rows.push("");
    rows.push(`### 问题 (${formatTs(p.question.created_at) || "-"})`);
    rows.push("");
    rows.push(qText || "-");
    rows.push("");
    rows.push(`### 回答 (${formatTs(p.answer.created_at) || "-"})`);
    rows.push("");
    rows.push(aText || "-");
    rows.push("");
    rows.push("---");
    rows.push("");
  });
  return rows.join("\n");
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function refreshChannels(setChannels: (c: Channel[]) => void, token?: string) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  fetch(`${API}/channels`, { headers })
    .then((r) => r.json())
    .then((d) => d.data && setChannels(d.data))
    .catch(console.error);
}

function refreshWorkspaces(setWorkspaces: (w: Workspace[]) => void, token?: string) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  fetch(`${API}/workspaces`, { headers })
    .then((r) => r.json())
    .then((d) => d.data && setWorkspaces(d.data))
    .catch(console.error);
}

/** 引导动态表单：根据 schema 渲染并提交，成功后回调 */
function GuideFormBlock({
  msgId: _msgId,
  form,
  channelId,
  onReply,
  onChannelsRefresh,
  userToken,
}: {
  msgId: string;
  form: GuideFormSchema;
  channelId: string;
  onReply: (msg: Message) => void;
  onChannelsRefresh: () => void;
  userToken?: string;
}) {
  const authHeaders: Record<string, string> = userToken ? { Authorization: `Bearer ${userToken}` } : {};
  const [values, setValues] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, { value: string; label: string }[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    form.fields.forEach((f) => {
      if (f.type === "select" && f.options_url) {
        fetch(`${API}${f.options_url}`, { headers: authHeaders })
          .then((r) => r.json())
          .then((d) => {
            if (d.data && Array.isArray(d.data)) {
              const val = f.option_value || "value";
              const lab = f.option_label || "label";
              setOptions((prev) => ({
                ...prev,
                [f.name]: d.data.map((o: Record<string, string>) => ({
                  value: o[val],
                  label: o[lab] ?? o[val],
                })),
              }));
            }
          })
          .catch(() => {});
      }
    });
  }, [form.fields]);

  const handleSubmit = () => {
    if (form.action === "create_channel") {
      const workspace_id = values.workspace_id;
      const name = values.name?.trim();
      if (!workspace_id || !name) {
        const msg = "请选择工作空间并填写项目名称";
        setError(msg);
        toast.error(msg);
        return;
      }
      setError(null);
      fetch(`${API}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ workspace_id, name, type: "public" }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.status === "success") {
            setSubmitted(true);
            const chName = d.data?.name ?? name;
            return fetch(`${API}/channels/${channelId}/guide-reply`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: `项目「${chName}」已创建。你可以在左侧列表中看到新项目。`,
              }),
            })
              .then((res) => res.json())
              .then((res) => {
                if (res.data) onReply(res.data);
                onChannelsRefresh();
              });
          }
          const errMsg = d.detail || d.message || "创建失败";
          setError(errMsg);
          toast.error(errMsg);
        })
        .catch(() => {
          setError("请求失败");
          toast.error("请求失败");
        });
    }
  };

  if (submitted) {
    return <p className="text-sm text-green-600 mt-2">已提交并创建项目。</p>;
  }

  return (
    <div className="mt-2 p-3 bg-[#F8F8F8] rounded-lg border border-gray-200 text-sm">
      {form.fields.map((f) => (
        <div key={f.name} className="mb-3">
          <label className="block text-gray-700 text-xs font-medium mb-1">{f.label}</label>
          {f.type === "select" ? (
            <select
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              className="border border-gray-300 rounded px-2 py-1.5 w-full text-sm focus:outline-none focus:border-[#1264A3]"
            >
              <option value="">请选择</option>
              {(options[f.name] ?? []).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              placeholder={f.placeholder}
              className="border border-gray-300 rounded px-2 py-1.5 w-full text-sm focus:outline-none focus:border-[#1264A3]"
            />
          )}
        </div>
      ))}
      {error && <p className="text-red-500 text-xs mb-2">{error}</p>}
      <button
        type="button"
        onClick={handleSubmit}
        className="px-4 py-1.5 bg-[#007a5a] text-white rounded font-medium text-sm hover:bg-[#006a4d]"
      >
        提交
      </button>
    </div>
  );
}

function isClarifyReplyUserMessage(content: string): boolean {
  const t = (content || "").trim();
  return t.startsWith("@channel bot 澄清回答：") || t.includes("用户选择跳过澄清");
}

function ClarifyInlineBlock({
  msgId,
  schema,
  status,
  replyContent,
  onContinue,
  onSkip,
}: {
  msgId: string;
  schema: ClarifySchema;
  status: "form" | "waiting" | "answered";
  replyContent?: string;
  onContinue: (answers: ClarifyAnswers) => void;
  onSkip: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [optionText, setOptionText] = useState<Record<string, string>>({}); // key: `${q.id}:${opt.id}`
  const allowSkip = (schema.skip_policy || "allow") === "allow";
  const canContinue = schema.questions.every((q) => {
    const selected = answers[q.id] || [];
    if (selected.length === 0) return false;
    if (selected.includes(OTHER_CHOICE_ID)) {
      return !!(otherText[q.id] || "").trim();
    }
    for (const opt of q.options) {
      if (opt.requires_text && selected.includes(opt.id)) {
        const key = `${q.id}:${opt.id}`;
        if (!(optionText[key] || "").trim()) return false;
      }
    }
    return true;
  });

  const toggleOption = (q: ClarifyQuestion, optionId: string) => {
    setAnswers((prev) => {
      const current = prev[q.id] || [];
      if (q.allow_multiple) {
        const next = current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId];
        return { ...prev, [q.id]: next };
      }
      return { ...prev, [q.id]: [optionId] };
    });
  };

  const toggleOther = (q: ClarifyQuestion) => toggleOption(q, OTHER_CHOICE_ID);

  if (status === "waiting") {
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-[#F8F8F8] p-3">
        <span className="text-xs text-gray-400 flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-gray-300 animate-pulse" />
          引导正在根据澄清回答…
        </span>
      </div>
    );
  }

  if (status === "answered") {
    const displayReply = replyContent?.replace(/^@channel bot\s*澄清回答[：:]\s*/i, "").trim() || "";
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-[#F8F8F8] overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-100 flex items-center gap-1.5"
        >
          <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>▶</span>
          <span className="font-medium">澄清</span>
          <span className="text-gray-400">{open ? "收起" : "展开"}</span>
        </button>
        {open && (
          <div className="px-3 pb-3 text-xs text-gray-600 border-t border-gray-200 space-y-2 pt-2">
            <p className="text-gray-500">已澄清并已收到引导回复</p>
            {displayReply && (
              <div className="rounded border border-gray-200 bg-white p-2">
                <p className="text-gray-400 mb-1">澄清回答</p>
                <pre className="whitespace-pre-wrap text-gray-700 font-sans text-xs">{displayReply}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-[#1264A3]/30 bg-[#F8F8F8] overflow-hidden p-3">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-gray-800">{schema.title || "请先确认以下问题"}</h4>
      </div>
      <div className="space-y-2 max-h-[40vh] overflow-auto pr-1">
        {schema.questions.map((q, idx) => (
          <div key={q.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="text-sm mb-2 text-gray-700 font-medium">{idx + 1}. {q.prompt}</p>
            <div className="space-y-1.5">
              {q.options.map((opt) => {
                const checked = (answers[q.id] || []).includes(opt.id);
                const optKey = `${q.id}:${opt.id}`;
                return (
                  <div key={opt.id} className="space-y-1">
                    <label className="flex items-center gap-2 text-sm cursor-pointer text-gray-700 hover:text-gray-900">
                      <input
                        type={q.allow_multiple ? "checkbox" : "radio"}
                        name={`${msgId}-${q.id}`}
                        checked={checked}
                        onChange={() => toggleOption(q, opt.id)}
                        className="accent-[#1264A3]"
                      />
                      <span>{opt.label}</span>
                    </label>
                    {opt.requires_text && checked && (
                      <input
                        type="text"
                        value={optionText[optKey] || ""}
                        onChange={(e) => setOptionText((prev) => ({ ...prev, [optKey]: e.target.value }))}
                        placeholder={opt.text_placeholder || "请输入"}
                        className="ml-6 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:border-[#1264A3]"
                      />
                    )}
                  </div>
                );
              })}
              {q.other_enabled && (
                <div className="pt-1">
                  <label className="flex items-center gap-2 text-sm cursor-pointer text-gray-700 hover:text-gray-900">
                    <input
                      type={q.allow_multiple ? "checkbox" : "radio"}
                      name={`${msgId}-${q.id}`}
                      checked={(answers[q.id] || []).includes(OTHER_CHOICE_ID)}
                      onChange={() => toggleOther(q)}
                      className="accent-[#1264A3]"
                    />
                    <span>{q.other_label || "其他"}</span>
                  </label>
                  {(answers[q.id] || []).includes(OTHER_CHOICE_ID) && (
                    <input
                      type="text"
                      value={otherText[q.id] || ""}
                      onChange={(e) => setOtherText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder={q.other_placeholder || "请输入其他补充"}
                      className="mt-1.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:border-[#1264A3]"
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {allowSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="px-4 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 text-sm font-medium"
          >
            跳过
          </button>
        )}
        <button
          type="button"
          disabled={!canContinue}
          onClick={() => onContinue({ selected: answers, other_text: otherText, option_text: optionText })}
          className="px-4 py-1.5 rounded bg-[#007a5a] text-white font-medium disabled:opacity-40 text-sm hover:bg-[#006a4d]"
        >
          继续
        </button>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="p-2 rounded bg-amber-50 border-l-2 border-amber-400 text-sm text-gray-600 animate-pulse">
      正在思考...
    </div>
  );
}

// ── User Profile Modal ────────────────────────────────────────────────────────
function UserProfileModal({
  currentUser,
  userToken,
  onClose,
  onProfileUpdated,
}: {
  currentUser: { user_id: string; username: string; display_name: string; role: string };
  userToken: string;
  onClose: () => void;
  onProfileUpdated: (data: { display_name: string; bio?: string }) => void;
}) {
  const [displayName, setDisplayName] = useState(currentUser.display_name || "");
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [tab, setTab] = useState<"profile" | "password">("profile");
  const [pwVerifyMode, setPwVerifyMode] = useState<"password" | "email">("password");
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [emailCodeLoading, setEmailCodeLoading] = useState(false);
  const [userEmail, setUserEmail] = useState<string>("");

  useEffect(() => {
    fetch(`${API}/auth/users/me`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.display_name !== undefined) setDisplayName(d.display_name || "");
        if (d.bio !== undefined) setBio(d.bio || "");
        if (d.email !== undefined) setUserEmail(d.email || "");
      })
      .catch(() => {});
  }, [userToken]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/auth/users/me`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ display_name: displayName, bio }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "保存失败");
      onProfileUpdated({ display_name: data.display_name || displayName, bio: data.bio });
      toast.success("个人资料已更新");
      onClose();
    } catch (e: any) {
      toast.error(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleSendEmailCode = async () => {
    if (!userEmail) { toast.error("账号未绑定邮箱"); return; }
    setEmailCodeLoading(true);
    try {
      const res = await fetch(`${API}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ email: userEmail, purpose: "change_password" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "发送失败");
      setEmailCodeSent(true);
      toast.success("验证码已发送至 " + userEmail);
    } catch (e: any) {
      toast.error(e.message || "发送失败");
    } finally {
      setEmailCodeLoading(false);
    }
  };

  const handlePasswordChange = async () => {
    if (!newPassword) return;
    if (newPassword !== confirmPassword) { toast.error("两次输入的新密码不一致"); return; }
    if (pwVerifyMode === "password" && !currentPassword) return;
    if (pwVerifyMode === "email" && !emailCode) return;
    setPasswordSaving(true);
    try {
      const body: Record<string, string> = { new_password: newPassword };
      if (pwVerifyMode === "password") body.current_password = currentPassword;
      else body.email_code = emailCode;
      const res = await fetch(`${API}/auth/users/me/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "密码修改失败");
      toast.success("密码已更新");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setEmailCode(""); setEmailCodeSent(false);
    } catch (e: any) {
      toast.error(e.message || "密码修改失败");
    } finally {
      setPasswordSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]";

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center px-6 pt-5 pb-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-lg font-bold text-gray-900">个人资料</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Avatar + username */}
        <div className="flex items-center gap-4 px-6 py-4 flex-shrink-0">
          <div className="w-16 h-16 rounded-full bg-[#1264A3] text-white flex items-center justify-center text-2xl font-bold flex-shrink-0">
            {(displayName || currentUser.username).slice(0, 1).toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-gray-900">{displayName || currentUser.username}</p>
            <p className="text-xs text-gray-400">@{currentUser.username}</p>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 mt-1 inline-block">{currentUser.role}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 px-6 flex-shrink-0">
          {(["profile", "password"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`pb-2 mr-4 text-sm font-medium border-b-2 transition-colors ${
                tab === t ? "border-[#1264A3] text-[#1264A3]" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t === "profile" ? "基本信息" : "修改密码"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {tab === "profile" ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">显示名称</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="输入你的显示名称"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">个人简介</label>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="介绍一下你自己…"
                  className={`${inputCls} resize-none`}
                  rows={4}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Verify mode toggle */}
              <div className="flex gap-2 p-1 bg-gray-100 rounded-lg">
                <button type="button" onClick={() => setPwVerifyMode("password")} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${pwVerifyMode === "password" ? "bg-white shadow text-gray-800" : "text-gray-500 hover:text-gray-700"}`}>密码验证</button>
                <button type="button" onClick={() => setPwVerifyMode("email")} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${pwVerifyMode === "email" ? "bg-white shadow text-gray-800" : "text-gray-500 hover:text-gray-700"}`}>邮箱验证</button>
              </div>

              {pwVerifyMode === "password" ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">当前密码</label>
                  <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="输入当前密码" className={inputCls} autoComplete="current-password" />
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">邮箱验证码</label>
                  {userEmail ? (
                    <div className="flex gap-2">
                      <input value={emailCode} onChange={(e) => setEmailCode(e.target.value)} placeholder="输入验证码" className={`${inputCls} flex-1`} />
                      <button type="button" disabled={emailCodeLoading} onClick={handleSendEmailCode} className="px-3 py-2 text-xs bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap">
                        {emailCodeLoading ? "发送中" : emailCodeSent ? "重新发送" : "获取验证码"}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-red-500">账号未绑定邮箱，无法使用邮箱验证</p>
                  )}
                  {userEmail && <p className="text-xs text-gray-400 mt-1">验证码将发送至 {userEmail}</p>}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">新密码</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="输入新密码" className={inputCls} autoComplete="new-password" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">确认新密码</label>
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="再次输入新密码" className={inputCls} autoComplete="new-password" />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
          >
            取消
          </button>
          {tab === "profile" ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0f5a94] disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handlePasswordChange}
              disabled={passwordSaving || !newPassword || !confirmPassword || (pwVerifyMode === "password" && !currentPassword) || (pwVerifyMode === "email" && !emailCode)}
              className="px-4 py-2 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0f5a94] disabled:opacity-50"
            >
              {passwordSaving ? "更新中…" : "更新密码"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Channel Profile Modal ─────────────────────────────────────────────────────
function ChannelProfileModal({
  channelId,
  channelName,
  userToken,
  onClose,
}: {
  channelId: string;
  channelName: string;
  userToken: string;
  onClose: () => void;
}) {
  const [nickname, setNickname] = useState("");
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API}/channels/${channelId}/my-profile`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.data) {
          setNickname(d.data.nickname || "");
          setBio(d.data.bio || "");
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channelId, userToken]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/channels/${channelId}/my-profile`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ nickname: nickname || null, bio: bio || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "保存失败");
      toast.success("频道资料已更新");
      onClose();
    } catch (e: any) {
      toast.error(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]";

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center px-6 pt-5 pb-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold text-gray-900">我在频道的资料</h2>
            <p className="text-xs text-gray-400 mt-0.5">#{channelName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400 text-sm">加载中…</div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
                在这里设置的昵称和简介仅在本频道内显示，不影响其他频道。
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">频道昵称</label>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="留空则使用全局显示名称"
                  className={inputCls}
                  maxLength={64}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">频道简介</label>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="在本频道的身份介绍…"
                  className={`${inputCls} resize-none`}
                  rows={4}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="px-4 py-2 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0f5a94] disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // 用户认证状态
  type CurrentUser = { user_id: string; username: string; display_name: string; role: string } | null;

  // 从 localStorage 恢复登录状态
  const getStoredUser = (): CurrentUser => {
    try {
      const stored = localStorage.getItem("currentUser");
      if (!stored) return null;
      const data = JSON.parse(stored);
      // 检查是否在24小时内
      if (data.loginTime && Date.now() - data.loginTime < 86400000) {
        return data.user;
      }
    } catch {}
    return null;
  };

  const getStoredToken = (): string | null => {
    try {
      const stored = localStorage.getItem("currentUser");
      if (!stored) return null;
      const data = JSON.parse(stored);
      if (data.loginTime && Date.now() - data.loginTime < 86400000) {
        return data.token ?? data.user?.user_id ?? null;
      }
    } catch {}
    return null;
  };

  const [currentUser, setCurrentUser] = useState<CurrentUser>(getStoredUser);
  const [authToken, setAuthToken] = useState<string | null>(getStoredToken);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  // mode: "login" | "register" | "forgot"
  const [authMode, setAuthMode] = useState<"login" | "register" | "forgot">("login");
  const [regEmail, setRegEmail] = useState("");
  const [regCode, setRegCode] = useState("");
  const [regCodeSent, setRegCodeSent] = useState(false);
  const [regCodeLoading, setRegCodeLoading] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotCode, setForgotCode] = useState("");
  const [forgotNewPw, setForgotNewPw] = useState("");
  const [forgotCodeSent, setForgotCodeSent] = useState(false);
  const [forgotCodeLoading, setForgotCodeLoading] = useState(false);

  // 当前用户ID（用于API调用）
  const currentUserId = currentUser?.user_id || DEV_USER_ID;

  // 带认证头的 fetch 工具
  const authFetch = useCallback(
    (url: string, options: RequestInit = {}) =>
      fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(options.headers as Record<string, string> | undefined),
        },
      }),
    [authToken]
  );

  // 初始化时检查登录状态
  useEffect(() => {
    if (!currentUser) {
      setLoginModalOpen(true);
    }
  }, []);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [contextData, setContextData] = useState<ContextData>({});
  const [pendingFileIds, setPendingFileIds] = useState<string[]>([]);
  const [pendingFileNames, setPendingFileNames] = useState<string[]>([]);
  const [pendingFilePreviews, setPendingFilePreviews] = useState<(string | null)[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const fileImgInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!uploadMenuOpen) return;
    const handle = (e: MouseEvent) => {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(e.target as Node)) {
        setUploadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [uploadMenuOpen]);
  const [selectedQaIds, setSelectedQaIds] = useState<Record<string, boolean>>({});
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryPreview, setSummaryPreview] = useState("");
  const [qaLlmReady, setQaLlmReady] = useState(false);
  const [qaLlmHint, setQaLlmHint] = useState("正在检查 LLM 配置...");
  const [pendingClarifyReplyMsgId, setPendingClarifyReplyMsgId] = useState<string | null>(null);
  const [autoAssist, setAutoAssist] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const toggleThread = (rootId: string) =>
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      next.has(rootId) ? next.delete(rootId) : next.add(rootId);
      return next;
    });
  const [collapsedMessages, setCollapsedMessages] = useState<Set<string>>(new Set());
  const toggleMessage = (msgId: string) =>
    setCollapsedMessages((prev) => {
      const next = new Set(prev);
      next.has(msgId) ? next.delete(msgId) : next.add(msgId);
      return next;
    });

  type ChannelBot = { member_id: string; username: string; avatar_url?: string; display_name?: string };
  type ChannelUser = { member_id: string; username: string; avatar_url?: string; display_name?: string };
  type BotItem = { bot_id: string; username: string; display_name?: string; intro?: string; avatar_url?: string };
  const [channelBots, setChannelBots] = useState<ChannelBot[]>([]);
  const [channelUsers, setChannelUsers] = useState<ChannelUser[]>([]);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionDropdownPlacement, setMentionDropdownPlacement] = useState<"top" | "bottom">("bottom");
  // 文生图 / 图生图状态
  const [imageGenOpen, setImageGenOpen] = useState(false);
  const [imageGenTab, setImageGenTab] = useState<"gen" | "edit">("gen");
  const [imageGenPrompt, setImageGenPrompt] = useState("");
  const [imageGenModel, setImageGenModel] = useState("qwen-image-2.0-pro");
  const [imageGenSize, setImageGenSize] = useState("1024*1024");
  const [imageGenLoading, setImageGenLoading] = useState(false);
  const [imageGenPreview, setImageGenPreview] = useState<{ file_id: string; preview_url: string } | null>(null);
  // 图生图源图片
  const [imageEditModel, setImageEditModel] = useState("qwen-image-edit-max");
  const [imageEditSourceFileId, setImageEditSourceFileId] = useState("");
  const [imageEditPrompt, setImageEditPrompt] = useState("");
  const [imageEditSize, setImageEditSize] = useState("1024*1024");
  const [imageEditLoading, setImageEditLoading] = useState(false);
  const [imageEditPreview, setImageEditPreview] = useState<{ file_id: string; preview_url: string } | null>(null);
  // 加密消息状态
  const [secretMode, setSecretMode] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [secretTokens, setSecretTokens] = useState<Record<string, string>>({}); // msg_id -> token（仅发送方当次 session 持有）
  const [secretNow, setSecretNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setSecretNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Lightbox 状态
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxFileId, setLightboxFileId] = useState<string | null>(null);
  // 文件预览侧边栏
  const [filePreviewPanel, setFilePreviewPanel] = useState<{ url: string; filename: string } | null>(null);
  // 可伸缩面板宽度
  const [leftWidth, onLeftResize] = useResize(256, 160, 480, "right");
  const [memoryWidth, onMemoryResize] = useResize(288, 200, 600, "left");
  const [filePreviewWidth, onFilePreviewResize] = useResize(420, 280, 720, "left");
  const [addBotOpen, setAddBotOpen] = useState(false);
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [inviteWsMemberOpen, setInviteWsMemberOpen] = useState(false);
  const [inviteWsIdentifier, setInviteWsIdentifier] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [allBots, setAllBots] = useState<BotItem[]>([]);
  const [selectedBotIds, setSelectedBotIds] = useState<Set<string>>(new Set());
  const [addingBots, setAddingBots] = useState(false);
  const [manageMembersOpen, setManageMembersOpen] = useState(false);
  const [friendsPanelOpen, setFriendsPanelOpen] = useState(false);
  const [userProfileOpen, setUserProfileOpen] = useState(false);
  const [channelProfileOpen, setChannelProfileOpen] = useState(false);
  const [_expandedOlderIds, _setExpandedOlderIds] = useState<Set<string>>(new Set());
  const [, setHasMore] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const secretInputRef = useRef<HTMLInputElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [waitingForBotReply, setWaitingForBotReply] = useState(false);
  const [processingBots, setProcessingBots] = useState<Record<string, string>>({});

  // 登录/注册处理函数
  const handleLogin = async (username: string, password: string) => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "登录失败");
      const user = { user_id: data.user_id, username: data.username, display_name: data.display_name || data.username, role: data.role };
      const token: string = data.token || data.user_id;
      setCurrentUser(user);
      setAuthToken(token);
      // 保存到 localStorage（24小时有效）
      localStorage.setItem("currentUser", JSON.stringify({ user, token, loginTime: Date.now() }));
      setLoginModalOpen(false);
    } catch (e: any) {
      setLoginError(e.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleSendCode = async (email: string, purpose: string, onSent: () => void) => {
    if (!email.trim() || !email.includes("@")) { setLoginError("请输入有效的邮箱地址"); return; }
    if (purpose === "register") setRegCodeLoading(true);
    else setForgotCodeLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), purpose }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "发送失败");
      onSent();
      toast.success("验证码已发送，请查收邮件");
    } catch (e: any) {
      setLoginError(e.message);
    } finally {
      if (purpose === "register") setRegCodeLoading(false);
      else setForgotCodeLoading(false);
    }
  };

  const handleRegister = async (username: string, password: string, displayName: string) => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email: regEmail.trim(), password, display_name: displayName, code: regCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "注册失败");
      const loginRes = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const loginData = await loginRes.json();
      const user = { user_id: data.user_id, username: data.username, display_name: data.display_name || data.username, role: data.role };
      const token: string = loginData.token || data.user_id;
      setCurrentUser(user);
      setAuthToken(token);
      localStorage.setItem("currentUser", JSON.stringify({ user, token, loginTime: Date.now() }));
      setLoginModalOpen(false);
      setRegEmail(""); setRegCode(""); setRegCodeSent(false);
    } catch (e: any) {
      setLoginError(e.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!forgotCode.trim() || !forgotNewPw.trim()) { setLoginError("请填写验证码和新密码"); return; }
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim(), code: forgotCode, new_password: forgotNewPw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "重置失败");
      toast.success("密码已重置，请重新登录");
      setAuthMode("login");
      setForgotEmail(""); setForgotCode(""); setForgotNewPw(""); setForgotCodeSent(false);
    } catch (e: any) {
      setLoginError(e.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setAuthToken(null);
    localStorage.removeItem("currentUser");
    setLoginModalOpen(true);
  };

  // 创建工作空间
  const handleCreateWorkspace = () => {
    if (!newWorkspaceName.trim()) {
      toast.error("请填写工作空间名称");
      return;
    }
    authFetch(`${API}/workspaces`, {
      method: "POST",
      body: JSON.stringify({ name: newWorkspaceName.trim() }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("工作空间创建成功");
          setNewWorkspaceName("");
          setCreateWsOpen(false);
          refreshWorkspaces(setWorkspaces, authToken ?? undefined);
          setSelectedWorkspaceId(d.data.workspace_id);
        } else {
          toast.error(d.detail || "创建失败");
        }
      })
      .catch(() => toast.error("创建失败"));
  };

  // 邀请成员加入工作空间
  const handleInviteWsMember = () => {
    if (!inviteWsIdentifier.trim()) {
      toast.error("请输入用户名");
      return;
    }
    if (!selectedWorkspaceId) {
      toast.error("请先选择工作空间");
      return;
    }
    authFetch(`${API}/workspaces/${selectedWorkspaceId}/invite`, {
      method: "POST",
      body: JSON.stringify({ identifier: inviteWsIdentifier.trim() }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success(d.message || "邀请成功");
          setInviteWsIdentifier("");
          setInviteWsMemberOpen(false);
        } else {
          toast.error(d.detail || "邀请失败");
        }
      })
      .catch(() => toast.error("邀请失败"));
  };

  // 创建频道（项目）
  const handleCreateChannel = () => {
    if (!newChannelName.trim()) {
      toast.error("请填写频道名称");
      return;
    }
    if (!selectedWorkspaceId) {
      toast.error("请先选择工作空间");
      return;
    }
    authFetch(`${API}/channels`, {
      method: "POST",
      body: JSON.stringify({
        workspace_id: selectedWorkspaceId,
        name: newChannelName.trim(),
        type: "public",
        purpose: "",
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("频道创建成功");
          setNewChannelName("");
          setCreateChannelOpen(false);
          refreshChannels(setChannels, authToken ?? undefined);
          setSelectedId(d.data.channel_id);
        } else {
          toast.error(d.detail || "创建失败");
        }
      })
      .catch(() => toast.error("创建失败"));
  };

  function introSummary(intro: string | undefined): string {
    if (!intro) return "";
    try {
      const o = JSON.parse(intro);
      if (o.description) return o.description;
      if (Array.isArray(o.capabilities)) return o.capabilities.join(", ");
      return intro.slice(0, 50) + (intro.length > 50 ? "…" : "");
    } catch {
      return intro.slice(0, 50) + (intro.length > 50 ? "…" : "");
    }
  }

  useEffect(() => {
    refreshChannels(setChannels, authToken ?? undefined);
    refreshWorkspaces(setWorkspaces, authToken ?? undefined);
  }, [authToken]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setChannelBots([]);
      setSelectedQaIds({});
      setSummaryPreview("");
      setWaitingForBotReply(false);
      setProcessingBots({});
      setAutoAssist(false);
      setReplyingTo(null);
      return;
    }
    const ch = channels.find((c) => c.channel_id === selectedId);
    setAutoAssist(ch?.auto_assist ?? false);
    setLoading(true);
    fetch(`${API}/channels/${selectedId}/members?with_username=1`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data) {
          const bots: ChannelBot[] = d.data
            .filter((m: { member_type: string; username?: string }) => m.member_type === "bot" && m.username)
            .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }));
          setChannelBots(bots);
          const users: ChannelUser[] = d.data
            .filter((m: { member_type: string; username?: string }) => m.member_type === "user" && m.username)
            .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }));
          setChannelUsers(users);
        } else { setChannelBots([]); setChannelUsers([]); }
      })
      .catch(() => {
        setChannelBots([]);
      });
    fetch(`${API}/channels/${selectedId}/messages`)
      .then((r) => r.json())
      .then((d) => {
        const data = d.data || [];
        setMessages(data);
        setHasMore(data.length >= 30);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const ws = new WebSocket(`${WS_BASE}/ws/channels/${selectedId}`);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "message" && msg.data) {
          setMessages((prev) => {
            const id = msg.data.msg_id;
            if (id && prev.some((m) => m.msg_id === id)) return prev;
            const entry = msg.data.sender_type === "bot"
              ? { ...msg.data, _streaming: true }
              : msg.data;
            return [...prev, entry];
          });
          if (
            msg.data.sender_type === "bot" &&
            typeof msg.data.content === "string" &&
            msg.data.content.includes("已更新记忆层")
          ) {
            fetch(`${API}/channels/${selectedId}/context`)
              .then((r) => r.json())
              .then((d) => d.data && setContextData(d.data))
              .catch(() => {});
          }
        } else if (msg.type === "message_stream" && msg.data) {
          const { msg_id, delta } = msg.data;
          setMessages((prev) =>
            prev.map((m) =>
              m.msg_id === msg_id ? { ...m, content: m.content + delta, _streaming: true } : m
            )
          );
        } else if (msg.type === "message_done" && msg.data) {
          const { msg_id, content } = msg.data;
          setMessages((prev) =>
            prev.map((m) =>
              m.msg_id === msg_id ? { ...m, content, _streaming: false } : m
            )
          );
          if (typeof content === "string" && content.includes("已更新记忆层")) {
            fetch(`${API}/channels/${selectedId}/context`)
              .then((r) => r.json())
              .then((d) => d.data && setContextData(d.data))
              .catch(() => {});
          }
        }
      } catch {}
    };
    return () => ws.close();
  }, [selectedId]);

  useEffect(() => {
    if (memoryPanelOpen && selectedId) {
      fetch(`${API}/channels/${selectedId}/context`)
        .then((r) => r.json())
        .then((d) => d.data && setContextData(d.data))
        .catch(console.error);
    }
  }, [memoryPanelOpen, selectedId]);

  useEffect(() => {
    if (addBotOpen) {
      const headers: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      fetch(`${API}/bots`, { headers }).then((r) => r.json()).then((d) => setAllBots(d.data || [])).catch(() => setAllBots([]));
      setSelectedBotIds(new Set());
    }
  }, [addBotOpen, authToken]);



  useEffect(() => {
    if (showMentionDropdown && selectedId) {
      const headers: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      fetch(`${API}/bots`, { headers }).then((r) => r.json()).then((d) => setAllBots(d.data || [])).catch(() => setAllBots([]));
      fetch(`${API}/channels/${selectedId}/members?with_username=1`, { headers })
        .then((r) => r.json())
        .then((d) => {
          if (!d.data) return;
          setChannelBots(
            d.data
              .filter((m: { member_type: string; username?: string }) => m.member_type === "bot" && m.username)
              .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }))
          );
          setChannelUsers(
            d.data
              .filter((m: { member_type: string; username?: string }) => m.member_type === "user" && m.username)
              .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }))
          );
        })
        .catch(console.error);
    }
  }, [showMentionDropdown, selectedId, authToken]);

  const addBotToChannel = (botId: string): Promise<void> => {
    if (!selectedId) return Promise.resolve();
    return fetch(`${API}/channels/${selectedId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: botId, member_type: "bot" }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          fetch(`${API}/channels/${selectedId}/members?with_username=1`)
            .then((res) => res.json())
            .then((res) => {
              if (res.data) {
                const bots: ChannelBot[] = res.data
                  .filter((m: { member_type: string; username?: string }) => m.member_type === "bot" && m.username)
                  .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }));
                setChannelBots(bots);
                const users: ChannelUser[] = res.data
                  .filter((m: { member_type: string; username?: string }) => m.member_type === "user" && m.username)
                  .map((m: { member_id: string; username: string; avatar_url?: string; display_name?: string }) => ({ member_id: m.member_id, username: m.username, avatar_url: m.avatar_url, display_name: m.display_name }));
                setChannelUsers(users);
              }
            });
        }
      })
      .catch(console.error);
  };

  const removeBotFromChannel = (memberId: string) => {
    if (!selectedId) return;
    fetch(`${API}/channels/${selectedId}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          setChannelBots((prev) => prev.filter((b) => b.member_id !== memberId));
        }
      })
      .catch(console.error);
  };

  useEffect(() => {
    if (!pendingClarifyReplyMsgId) return;
    // 在澄清表单消息之后找到用户的答复，再之后有 Bot 回复则视为已完成
    const clarifyIdx = messages.findIndex((m) => m.msg_id === pendingClarifyReplyMsgId);
    if (clarifyIdx === -1) return;
    const afterClarify = messages.slice(clarifyIdx + 1);
    const userReplyIdx = afterClarify.findIndex((m) => m.sender_type === "user");
    if (userReplyIdx === -1) return;
    const afterUserReply = afterClarify.slice(userReplyIdx + 1);
    if (afterUserReply.some((m) => m.sender_type === "bot")) {
      setPendingClarifyReplyMsgId(null);
    }
  }, [pendingClarifyReplyMsgId, messages]);

  useEffect(() => {
    setPendingClarifyReplyMsgId(null);
  }, [selectedId]);

  const sendUserMessage = (content: string, inReplyToMsgId?: string): Promise<void> => {
    if (!selectedId || !content.trim()) return Promise.resolve();
    const body: Record<string, unknown> = {
      content: content.trim(),
      sender_id: currentUserId,
      sender_type: "user",
      file_ids: [] as string[],
    };
    if (inReplyToMsgId) body.in_reply_to_msg_id = inReplyToMsgId;
    return fetch(`${API}/channels/${selectedId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        // 用户消息由 WebSocket 广播接收，这里仅作兜底去重插入
        if (d.data) {
          setMessages((prev) =>
            prev.some((m) => m.msg_id === d.data.msg_id) ? prev : [...prev, d.data]
          );
        }
      });
  };

  const send = () => {
    if (!selectedId || !input.trim()) return;
    let content = input.trim();
    if (replyingTo) {
      const refBot = replyingTo.sender_type === "bot"
        ? channelBots.find((b) => b.member_id === replyingTo.sender_id)
        : null;
      const refLabel = replyingTo.sender_type === "bot"
        ? (refBot?.display_name || refBot?.username || "Bot")
        : (currentUser?.display_name || "用户");
      const quotedRaw = parseGuidePayload(replyingTo.content).text || replyingTo.content;
      const quotedText = quotedRaw.replace(/\n+/g, " ").trim().slice(0, 400);
      content = `> [${refLabel}]: ${quotedText}\n\n${content}`;
    }
    const isSecretSend = secretMode;
    const body: Record<string, unknown> = {
      content,
      sender_id: currentUserId,
      sender_type: "user",
      file_ids: pendingFileIds,
      is_secret: isSecretSend,
    };
    if (replyingTo) body.in_reply_to_msg_id = replyingTo.msg_id;
    setInput("");
    setSecretMode(false);
    setPendingFileIds([]);
    setPendingFileNames([]);
    setPendingFilePreviews((prev) => { prev.forEach((u) => { if (u) URL.revokeObjectURL(u); }); return []; });
    setReplyingTo(null);
    fetch(`${API}/channels/${selectedId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        // 用户消息由 WebSocket 广播接收，这里仅作兜底去重插入
        if (d.data) {
          setMessages((prev) =>
            prev.some((m) => m.msg_id === d.data.msg_id) ? prev : [...prev, d.data]
          );
          // 保存 secret_token（仅发送方当次 session 持有，不通过 WS 广播）
          if (d.data.secret_token) {
            setSecretTokens((prev) => ({ ...prev, [d.data.msg_id]: d.data.secret_token }));
          }
        }
      })
      .catch(console.error);
  };

  const handleClarifyContinue = (msgId: string, schema: ClarifySchema, answers: ClarifyAnswers) => {
    const lines = ["@channel bot 澄清回答："];
    const optText = answers.option_text || {};
    for (const q of schema.questions) {
      const picked = new Set(answers.selected[q.id] || []);
      const labels = q.options
        .filter((o) => picked.has(o.id))
        .map((o) => {
          const txt = (optText[`${q.id}:${o.id}`] || "").trim();
          return txt ? `${o.label}：${txt}` : o.label;
        });
      if (picked.has(OTHER_CHOICE_ID)) {
        const other = (answers.other_text?.[q.id] || "").trim();
        if (other) labels.push(`其他：${other}`);
      }
      lines.push(`- ${q.prompt}：${labels.length > 0 ? labels.join("、") : "未选择"}`);
    }
    setPendingClarifyReplyMsgId(msgId);
    sendUserMessage(lines.join("\n"), msgId).catch(() => {
      setPendingClarifyReplyMsgId(null);
      toast.error("提交失败，请重试");
    });
  };

  const handleClarifySkip = (msgId: string) => {
    setPendingClarifyReplyMsgId(msgId);
    sendUserMessage("@channel bot 用户选择跳过澄清，请在当前信息下继续回答。", msgId).catch(() => {
      setPendingClarifyReplyMsgId(null);
      toast.error("提交失败，请重试");
    });
  };

  const PRESIGN_EXTS = new Set([".txt", ".docx", ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  const CONTENT_TYPE_MAP: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif",
    ".pdf": "application/pdf", ".txt": "text/plain",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };

  const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

  const uploadFileObject = async (file: File) => {
    if (!selectedId) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    const allowed = [".txt", ".md", ".docx", ".pdf", ".xlsx", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
    if (!allowed.includes(ext)) {
      toast.error(`不支持的格式：${ext}`);
      return;
    }
    const localPreview = IMAGE_EXTS.has(ext) ? URL.createObjectURL(file) : null;
    if (PRESIGN_EXTS.has(ext)) {
      const contentType = file.type || CONTENT_TYPE_MAP[ext] || "application/octet-stream";
      try {
        const presignRes = await fetch(`${API}/files/presign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel_id: selectedId,
            uploader_id: currentUserId,
            filename: file.name,
            content_type: contentType,
            size: file.size,
          }),
        });
        const presignData = await presignRes.json();
        if (!presignRes.ok || !presignData.data?.upload_url) {
          toast.error(presignData.detail || "获取上传凭证失败");
          if (localPreview) URL.revokeObjectURL(localPreview);
          return;
        }
        const { file_id, upload_url, headers: uploadHeaders } = presignData.data;
        const putRes = await fetch(upload_url, {
          method: "PUT",
          headers: uploadHeaders,
          body: file,
        });
        if (!putRes.ok) {
          toast.error("文件上传失败，请重试");
          if (localPreview) URL.revokeObjectURL(localPreview);
          return;
        }
        setPendingFileIds((prev) => [...prev, file_id]);
        setPendingFileNames((prev) => [...prev, file.name]);
        setPendingFilePreviews((prev) => [...prev, localPreview]);
      } catch (err) {
        toast.error("文件上传出错");
        if (localPreview) URL.revokeObjectURL(localPreview);
        console.error(err);
      }
    } else {
      fetch(
        `${API}/files/upload?channel_id=${encodeURIComponent(selectedId)}&uploader_id=${encodeURIComponent(currentUserId)}&filename=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file }
      )
        .then((r) => r.json())
        .then((d) => {
          if (d.data?.file_id) {
            setPendingFileIds((prev) => [...prev, d.data.file_id]);
            setPendingFileNames((prev) => [...prev, file.name]);
            setPendingFilePreviews((prev) => [...prev, localPreview]);
          } else if (localPreview) {
            URL.revokeObjectURL(localPreview);
          }
        })
        .catch(console.error);
    }
  };

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    await uploadFileObject(file);
  };

  // ── 文件附件渲染辅助 ──────────────────────────────────────────────────────
  const formatFileSize = (bytes?: number) => {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const fileTypeLabel = (ct?: string) => {
    if (!ct) return "文件";
    if (ct.includes("pdf")) return "PDF";
    if (ct.includes("wordprocessingml") || ct.includes("docx")) return "Word";
    if (ct.includes("text/plain")) return "文本";
    if (ct.startsWith("image/")) return "图片";
    return "文件";
  };

  const renderFileAttachments = (msg: Message, alignRight = false) => {
    const files = msg.files;
    if (!files || files.length === 0) return null;
    const images = files.filter((f) => (f.content_type || "").startsWith("image/"));
    const docs = files.filter((f) => !(f.content_type || "").startsWith("image/"));
    if (images.length === 0 && docs.length === 0) return null;
    return (
      <div className={`mb-1.5 space-y-1.5 ${alignRight ? "flex flex-col items-end" : ""}`}>
        {images.map((f) => (
          <div
            key={f.file_id}
            className="cursor-pointer rounded-xl overflow-hidden border border-gray-200 shadow-sm hover:shadow-md transition-shadow inline-block"
            onClick={() => { setLightboxSrc(`${API}/files/${f.file_id}/preview`); setLightboxFileId(f.file_id); }}
          >
            <img
              src={`${API}/files/${f.file_id}/preview`}
              alt={f.original_filename || "image"}
              className="max-w-[280px] max-h-[200px] object-cover block"
              loading="lazy"
            />
            {f.original_filename && (
              <div className="px-2.5 py-1.5 bg-white text-[11px] text-gray-500 border-t border-gray-100 flex items-center gap-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-gray-400">
                  <path fillRule="evenodd" d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm10.5 5.707a.5.5 0 0 0-.146-.353l-2.5-2.5a.5.5 0 0 0-.708 0L7.5 8.5 6.354 7.354a.5.5 0 0 0-.708 0l-3.146 3.15V12a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-2.293ZM11 5.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" clipRule="evenodd" />
                </svg>
                <span className="truncate max-w-[200px]">{f.original_filename}</span>
                {f.size_bytes ? <span className="text-gray-400">{formatFileSize(f.size_bytes)}</span> : null}
              </div>
            )}
          </div>
        ))}
        {docs.map((f) => (
          <a key={f.file_id} href={`${API}/files/${f.file_id}/download`} target="_blank" rel="noreferrer"
            className="flex items-center gap-2.5 px-3 py-2.5 bg-white border border-gray-200 rounded-xl shadow-sm max-w-[300px] hover:bg-gray-50 transition-colors cursor-pointer no-underline">
            <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-blue-500">
                <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 16 6.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-gray-700 truncate">{f.original_filename || f.file_id}</div>
              <div className="text-[11px] text-gray-400">{fileTypeLabel(f.content_type)}{f.size_bytes ? ` \u00B7 ${formatFileSize(f.size_bytes)}` : ""}</div>
            </div>
          </a>
        ))}
      </div>
    );
  };

  const saveContextLayer = (layer: string, content: string) => {
    if (!selectedId) return;
    fetch(`${API}/channels/${selectedId}/context`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layer, content }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") setContextData((prev) => ({ ...prev, [layer.toLowerCase()]: content }));
      })
      .catch(console.error);
  };

  const selectedChannel = channels.find((c) => c.channel_id === selectedId) || null;
  const blocks = buildLogicalQaBlocks(messages);
  const blockPairsForExport: QaPair[] = blocks.map((b) => {
    const lastBot = [...b.messages].reverse().find((m) => m.sender_type === "bot");
    const answer: Message = lastBot || {
      msg_id: `${b.question.msg_id}-no-reply`,
      sender_id: "",
      sender_type: "bot",
      content: "(无回复)",
      created_at: b.question.created_at,
    };
    return { question: b.question, answer };
  });
  const selectedPairs = blockPairsForExport.filter((p) => selectedQaIds[p.question.msg_id]);

  const exportMdFilename = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ch = (selectedChannel?.name || "channel").replace(/\s+/g, "_");
    return `qa-export-${ch}-${stamp}.md`;
  };

  const downloadQaMarkdown = () => {
    if (selectedPairs.length === 0) {
      toast.error("请勾选至少一组问答");
      return;
    }
    const md = buildQaMarkdown(selectedChannel?.name || "频道", selectedPairs);
    downloadText(exportMdFilename(), md);
  };

  const refreshQaLlmStatus = async () => {
    try {
      const llmRes = await authFetch(`${API}/admin/settings/llm`);
      const llmData = await llmRes.json();
      if (!llmRes.ok) {
        setQaLlmReady(false);
        setQaLlmHint("无法读取 LLM 配置，请稍后重试。");
        return false;
      }
      const bindings = llmData?.data?.bindings || {};
      const providers = llmData?.data?.providers || [];
      const pickedId = bindings.qa_summarize || bindings.system_llm;
      const picked = providers.find((p: { id: string; base_url?: string }) => p.id === pickedId);
      if (!picked || !String(picked.base_url || "").trim()) {
        setQaLlmReady(false);
        setQaLlmHint("未配置问答总结 LLM，请到「管理」页绑定问答总结或系统 LLM。");
        return false;
      }
      setQaLlmReady(true);
      setQaLlmHint("LLM 已配置，可生成总结。");
      return true;
    } catch {
      setQaLlmReady(false);
      setQaLlmHint("检查 LLM 配置失败，请稍后重试。");
      return false;
    }
  };

  // 进入频道或收到新消息时，聊天区域滚动到最新消息
  useEffect(() => {
    if (!messagesContainerRef.current) return;
    messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
  }, [selectedId, messages.length]);

  const generateQaSummary = async (pairsToSummarize: QaPair[]) => {
    if (pairsToSummarize.length === 0) {
      toast.error("请勾选至少一组问答");
      return;
    }
    setSummaryBusy(true);
    try {
      const ok = await refreshQaLlmStatus();
      if (!ok) {
        toast.error("请先在管理页配置并绑定可用 LLM（问答总结或系统 LLM）。");
        return;
      }

      const pairs = pairsToSummarize.map((p) => ({
        question: stripThinkTags(parseGuidePayload(p.question.content).text || p.question.content),
        answer: stripThinkTags(parseGuidePayload(p.answer.content).text || p.answer.content),
        question_time: formatTs(p.question.created_at),
        answer_time: formatTs(p.answer.created_at),
      }));
      const res = await authFetch(`${API}/admin/qa/summarize`, {
        method: "POST",
        body: JSON.stringify({
          channel_name: selectedChannel?.name || "频道",
          pairs,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.detail || data?.message || `总结失败 (${res.status})`);
      }
      const md = data?.data?.summary_markdown || "";
      if (!md.trim()) {
        throw new Error("未获得总结结果");
      }
      setSummaryPreview(md);
    } catch (e) {
      toast.error((e as Error).message || "生成总结失败");
    } finally {
      setSummaryBusy(false);
    }
  };

  useEffect(() => {
    if (!selectedId) return;
    refreshQaLlmStatus();
  }, [selectedId]);

  // Auto-expand threads that contain streaming (incoming) messages
  useEffect(() => {
    const msgIdSet = new Set(messages.map((x) => x.msg_id));
    const rootIdCache = new Map<string, string>();
    function getRootId(msgId: string): string {
      if (rootIdCache.has(msgId)) return rootIdCache.get(msgId)!;
      const m = messages.find((x) => x.msg_id === msgId);
      if (!m || !m.in_reply_to_msg_id || !msgIdSet.has(m.in_reply_to_msg_id)) {
        rootIdCache.set(msgId, msgId); return msgId;
      }
      const rid = getRootId(m.in_reply_to_msg_id);
      rootIdCache.set(msgId, rid); return rid;
    }
    const toExpand = messages
      .filter((m) => m._streaming && m.in_reply_to_msg_id)
      .map((m) => getRootId(m.msg_id));
    if (toExpand.length > 0)
      setExpandedThreads((prev) => new Set([...prev, ...toExpand]));
  }, [messages]);

  // Build thread tree: follow parent chain to find root, group all descendants under it
  const { threadRoots, threadRepliesOf } = (() => {
    const msgIdSet = new Set(messages.map((x) => x.msg_id));
    const rootIdCache = new Map<string, string>();
    function getRootId(msgId: string): string {
      if (rootIdCache.has(msgId)) return rootIdCache.get(msgId)!;
      const m = messages.find((x) => x.msg_id === msgId);
      if (!m || !m.in_reply_to_msg_id || !msgIdSet.has(m.in_reply_to_msg_id)) {
        rootIdCache.set(msgId, msgId);
        return msgId;
      }
      const rid = getRootId(m.in_reply_to_msg_id);
      rootIdCache.set(msgId, rid);
      return rid;
    }
    const replyMap = new Map<string, Message[]>();
    const replySet = new Set<string>();
    for (const m of messages) {
      const rootId = getRootId(m.msg_id);
      if (rootId !== m.msg_id) {
        replySet.add(m.msg_id);
        const arr = replyMap.get(rootId) ?? [];
        arr.push(m);
        replyMap.set(rootId, arr);
      }
    }
    for (const arr of replyMap.values()) {
      arr.sort((a, b) => (a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1);
    }
    return {
      threadRoots: messages.filter((m) => !replySet.has(m.msg_id)),
      threadRepliesOf: (rootId: string): Message[] => replyMap.get(rootId) ?? [],
    };
  })();

  return (
    <>
      {loginModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setLoginModalOpen(false)}>
          <div className="bg-white rounded-xl p-8 w-96 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-lg bg-[#4A154B] flex items-center justify-center mx-auto mb-3">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" className="w-7 h-7">
                  <path d="M4.5 6.375a4.125 4.125 0 118.25 0 4.125 4.125 0 01-8.25 0zM14.25 8.625a3.375 3.375 0 116.75 0 3.375 3.375 0 01-6.75 0zM1.5 19.125a7.125 7.125 0 0114.25 0v.003l-.001.119a.75.75 0 01-.363.63 13.067 13.067 0 01-6.761 1.873c-2.472 0-4.786-.684-6.76-1.873a.75.75 0 01-.364-.63l-.001-.122zM17.25 19.128l-.001.144a2.25 2.25 0 01-.233.96 10.088 10.088 0 005.06-1.01.75.75 0 00.42-.643 4.875 4.875 0 00-6.957-4.611 8.586 8.586 0 011.71 5.157v.003z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-gray-900">
                {authMode === "login" ? "登录到智枢" : authMode === "register" ? "创建账号" : "重置密码"}
              </h2>
              <p className="text-gray-500 text-sm mt-1">
                {authMode === "login" ? "欢迎回来！" : authMode === "register" ? "填写信息以创建新账号" : "通过邮箱验证重置密码"}
              </p>
            </div>
            {loginError && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 p-3 rounded-lg">{loginError}</div>}

            {/* ── Login ── */}
            {authMode === "login" && (
              <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); handleLogin(fd.get("username") as string, fd.get("password") as string); }}>
                <input name="username" placeholder="用户名或邮箱" required className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                <input name="password" type="password" placeholder="密码" required className="w-full mb-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                <div className="text-right mb-4">
                  <button type="button" onClick={() => { setAuthMode("forgot"); setLoginError(""); }} className="text-xs text-[#1264A3] hover:underline">忘记密码？</button>
                </div>
                <button type="submit" disabled={loginLoading} className="w-full bg-[#4A154B] text-white py-2.5 rounded-lg font-semibold hover:bg-[#3d1040] disabled:opacity-50 text-sm">
                  {loginLoading ? "处理中..." : "登录"}
                </button>
              </form>
            )}

            {/* ── Register ── */}
            {authMode === "register" && (
              <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); handleRegister(fd.get("username") as string, fd.get("password") as string, fd.get("display_name") as string); }}>
                <input name="display_name" placeholder="显示名称" required className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                <input name="username" placeholder="用户名（登录用）" required className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                <input name="password" type="password" placeholder="密码（8位以上，含字母和数字）" required className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                {/* Email + code */}
                <div className="flex gap-2 mb-3">
                  <input value={regEmail} onChange={(e) => setRegEmail(e.target.value)} type="email" placeholder="邮箱地址" required className="flex-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                  <button type="button" disabled={regCodeLoading || !regEmail.includes("@")} onClick={() => handleSendCode(regEmail, "register", () => setRegCodeSent(true))} className="px-3 py-2 text-xs bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap">
                    {regCodeLoading ? "发送中" : regCodeSent ? "重新发送" : "获取验证码"}
                  </button>
                </div>
                <input value={regCode} onChange={(e) => setRegCode(e.target.value)} placeholder="邮箱验证码" required className="w-full mb-4 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                <button type="submit" disabled={loginLoading || !regCodeSent} className="w-full bg-[#4A154B] text-white py-2.5 rounded-lg font-semibold hover:bg-[#3d1040] disabled:opacity-50 text-sm">
                  {loginLoading ? "处理中..." : "注册"}
                </button>
              </form>
            )}

            {/* ── Forgot Password ── */}
            {authMode === "forgot" && (
              <div>
                <div className="flex gap-2 mb-3">
                  <input value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} type="email" placeholder="注册邮箱" required className="flex-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                  <button type="button" disabled={forgotCodeLoading || !forgotEmail.includes("@")} onClick={() => handleSendCode(forgotEmail, "reset_password", () => setForgotCodeSent(true))} className="px-3 py-2 text-xs bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap">
                    {forgotCodeLoading ? "发送中" : forgotCodeSent ? "重新发送" : "获取验证码"}
                  </button>
                </div>
                <input value={forgotCode} onChange={(e) => setForgotCode(e.target.value)} placeholder="邮箱验证码" className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                <input value={forgotNewPw} onChange={(e) => setForgotNewPw(e.target.value)} type="password" placeholder="新密码（8位以上，含字母和数字）" className="w-full mb-4 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]" />
                <button onClick={handleForgotPassword} disabled={loginLoading || !forgotCodeSent} className="w-full bg-[#4A154B] text-white py-2.5 rounded-lg font-semibold hover:bg-[#3d1040] disabled:opacity-50 text-sm">
                  {loginLoading ? "处理中..." : "重置密码"}
                </button>
              </div>
            )}

            <div className="mt-4 text-center text-sm text-gray-500">
              {authMode === "login" ? (
                <>没有账号？ <button onClick={() => { setAuthMode("register"); setLoginError(""); }} className="text-[#1264A3] font-medium hover:underline">注册</button></>
              ) : (
                <button onClick={() => { setAuthMode("login"); setLoginError(""); }} className="text-[#1264A3] font-medium hover:underline">返回登录</button>
              )}
            </div>
          </div>
        </div>
      )}

    <div className="flex h-screen bg-white">
      {/* Slack-style dark purple sidebar */}
      <aside className="bg-[#3F0E40] flex flex-col flex-shrink-0 relative" style={{ width: leftWidth }}>
        {/* Workspace header */}
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-white font-bold text-lg truncate">智枢协作</span>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-white/60 flex-shrink-0">
              <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {currentUser ? (
              <>
                <button
                  type="button"
                  onClick={() => setUserProfileOpen(true)}
                  className="w-7 h-7 rounded-full bg-[#D0B3D3] text-[#3F0E40] text-xs font-bold flex items-center justify-center hover:bg-white transition-colors"
                  title={`${currentUser.display_name} · 编辑资料`}
                >
                  {currentUser.display_name.slice(0, 1).toUpperCase()}
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="w-6 h-6 flex items-center justify-center rounded text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                  title="退出登录"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path fillRule="evenodd" d="M2 4.75A2.75 2.75 0 0 1 4.75 2h3a2.75 2.75 0 0 1 2.75 2.75v.5a.75.75 0 0 1-1.5 0v-.5c0-.69-.56-1.25-1.25-1.25h-3c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h3c.69 0 1.25-.56 1.25-1.25v-.5a.75.75 0 0 1 1.5 0v.5A2.75 2.75 0 0 1 7.75 14h-3A2.75 2.75 0 0 1 2 11.25v-6.5Zm9.47.47a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1 0 1.06l-2.25 2.25a.75.75 0 1 1-1.06-1.06l.97-.97H6.75a.75.75 0 0 1 0-1.5h5.69l-.97-.97a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                  </svg>
                </button>
              </>
            ) : (
              <button onClick={() => setLoginModalOpen(true)} className="text-xs text-white/70 hover:text-white px-2 py-1">登录</button>
            )}
          </div>
        </div>

        {/* User status bar */}
        {currentUser && (
          <div className="px-4 py-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
            <span className="text-[#C9BDD0] text-sm truncate">{currentUser.display_name}</span>
          </div>
        )}

        {/* Workspace selector */}
        <div className="px-3 py-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[#C9BDD0] text-xs font-semibold uppercase tracking-wider">工作空间</span>
            <div className="flex items-center gap-1">
              {selectedWorkspaceId && (
                <button
                  type="button"
                  onClick={() => setInviteWsMemberOpen(true)}
                  className="text-white/60 hover:text-white text-xs p-1 rounded hover:bg-white/10"
                  title="邀请成员"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path d="M11 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM2.046 15.253c-.058.468.172.92.57 1.174A9.953 9.953 0 0 0 8 18c1.536 0 2.991-.346 4.184-.964l-4.253-4.25A3.5 3.5 0 0 0 5.6 11.5H5.5a3.5 3.5 0 0 0-3.454 3.753ZM15.5 9.5a.75.75 0 0 0-1.5 0v1.5H12.5a.75.75 0 0 0 0 1.5H14v1.5a.75.75 0 0 0 1.5 0V12.5h1.5a.75.75 0 0 0 0-1.5H15.5V9.5Z" />
                  </svg>
                </button>
              )}
              {selectedWorkspaceId && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm("确定删除该工作空间？删除后其下的频道也将被删除。")) {
                      authFetch(`${API}/workspaces/${selectedWorkspaceId}`, { method: "DELETE" })
                        .then((r) => r.json())
                        .then((d) => {
                          if (d.status === "success") {
                            toast.success("工作空间已删除");
                            setSelectedWorkspaceId("");
                            refreshWorkspaces(setWorkspaces, authToken ?? undefined);
                            refreshChannels(setChannels, authToken ?? undefined);
                          } else {
                            toast.error(d.detail || "删除失败");
                          }
                        })
                        .catch(() => toast.error("请求失败"));
                    }
                  }}
                  className="text-white/60 hover:text-red-400 text-xs p-1 rounded hover:bg-white/10"
                  title="删除工作空间"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => setCreateWsOpen(true)}
                className="text-white/60 hover:text-white text-xs p-1 rounded hover:bg-white/10"
                title="创建工作空间"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                </svg>
              </button>
            </div>
          </div>
          <select
            value={selectedWorkspaceId}
            onChange={(e) => setSelectedWorkspaceId(e.target.value)}
            className="w-full bg-white/10 text-white text-sm rounded px-2 py-1.5 border border-white/20 focus:outline-none focus:border-white/40"
          >
            <option value="" className="text-gray-900">全部工作空间</option>
            {workspaces.map((w) => (
              <option key={w.workspace_id} value={w.workspace_id} className="text-gray-900">
                {w.name}
              </option>
            ))}
          </select>
        </div>

        {/* Channels section */}
        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <span className="text-[#C9BDD0] text-xs font-semibold uppercase tracking-wider">频道</span>
          <button
            type="button"
            onClick={() => {
              if (!selectedWorkspaceId) {
                toast.error("请先选择工作空间");
                return;
              }
              setCreateChannelOpen(true);
            }}
            className="text-white/60 hover:text-white text-xs p-1 rounded hover:bg-white/10"
            title="创建频道"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
            </svg>
          </button>
        </div>
        <ul className="overflow-auto flex-1 px-2">
          {channels
            .filter((c) => !selectedWorkspaceId || c.workspace_id === selectedWorkspaceId)
            .map((c) => (
              <li key={c.channel_id} className="group relative">
                <button
                  type="button"
                  onClick={() => setSelectedId(c.channel_id)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[13px] flex items-center gap-1.5 transition-colors pr-7 ${
                    selectedId === c.channel_id
                      ? "bg-white/20 text-white font-semibold"
                      : "text-[#C9BDD0] hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <span className="text-current opacity-60 text-base leading-none">#</span>
                  <span className="truncate">{c.name}</span>
                  {!selectedWorkspaceId && c.workspace_id && (() => {
                    const ws = workspaces.find((w) => w.workspace_id === c.workspace_id);
                    const abbrev = ws ? ws.name.slice(0, 4) : "";
                    return abbrev ? (
                      <span className="ml-1 flex-shrink-0 text-[10px] px-1 py-0 rounded bg-white/10 text-[#C9BDD0] leading-4">
                        {abbrev}
                      </span>
                    ) : null;
                  })()}
                </button>
                <button
                  type="button"
                  title="删除频道"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!confirm(`确定删除频道「${c.name}」？此操作不可恢复。`)) return;
                    fetch(`${API}/channels/${c.channel_id}`, { method: "DELETE" })
                      .then((r) => {
                        if (!r.ok) throw new Error("删除失败");
                        setChannels((prev) => prev.filter((x) => x.channel_id !== c.channel_id));
                        if (selectedId === c.channel_id) setSelectedId(null);
                      })
                      .catch(() => toast.error("删除频道失败"));
                  }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/20 text-[#C9BDD0] hover:text-red-300"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5a.75.75 0 0 1 .786-.711Z" clipRule="evenodd" />
                  </svg>
                </button>
              </li>
            ))}
        </ul>

        {/* Bottom nav */}
        <div className="px-2 py-2 border-t border-white/10 space-y-0.5">
          <button
            type="button"
            onClick={() => setFriendsPanelOpen(true)}
            className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM1.49 15.326a.78.78 0 0 1-.358-.442 3 3 0 0 1 4.308-3.516 6.484 6.484 0 0 0-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 0 1-2.07-.655ZM16.44 15.98a4.97 4.97 0 0 0 2.07-.654.78.78 0 0 0 .357-.442 3 3 0 0 0-4.308-3.517 6.484 6.484 0 0 1 1.907 3.96 2.32 2.32 0 0 1-.026.654ZM18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.304 16.19a.844.844 0 0 1-.277-.71 5 5 0 0 1 9.947 0 .843.843 0 0 1-.277.71A6.975 6.975 0 0 1 10 18a6.974 6.974 0 0 1-4.696-1.81Z" />
            </svg>
            <span>好友</span>
          </button>
          <Link
            to="/admin"
            className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
            </svg>
            <span>管理</span>
          </Link>
          <Link
            to="/docs"
            className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M4 4a2 2 0 0 1 2-2h4.586A2 2 0 0 1 12 2.586L15.414 6A2 2 0 0 1 16 7.414V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Zm2 6a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H7a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H7Z" clipRule="evenodd" />
            </svg>
            <span>Docs</span>
          </Link>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[#C9BDD0] hover:bg-white/10 hover:text-white text-sm transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
            </svg>
            <span>帮助</span>
          </button>
        </div>
        {/* Left sidebar resize handle */}
        <div
          onMouseDown={onLeftResize}
          className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-white/30 transition-colors z-10"
        />
      </aside>

      {helpOpen && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40"
          onClick={() => setHelpOpen(false)}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6 text-left max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">使用帮助</h2>
              <button type="button" onClick={() => setHelpOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none" aria-label="关闭">
                ×
              </button>
            </div>
            <p className="text-gray-700 text-sm mb-3">
              在任意频道输入 <strong>@channel bot</strong> 并输入你的问题，channel bot 会根据说明书自动回复，并显示相关入口。
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
              <li>创建项目、Bot、性能监控、日志排查：左侧 <strong>管理</strong> 进入管理页面</li>
              <li>上传文件：频道内输入框旁 <strong>上传</strong>（.txt/.md/.docx/.pdf/.xlsx/.png/.jpg 等）</li>
              <li>频道上下文：选中频道后点击 <strong>频道上下文</strong></li>
              <li>API 文档：管理页内「打开 API 文档」或 <a href={API_DOCS_URL} target="_blank" rel="noreferrer" className="text-[#1264A3] underline">/docs</a></li>
            </ul>
            <p className="text-gray-500 text-xs">完整说明见项目文档。</p>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={() => setHelpOpen(false)} className="px-4 py-2 bg-[#F8F8F8] text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 创建工作空间 Modal */}
      {createWsOpen && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40"
          onClick={() => setCreateWsOpen(false)}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6 text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">创建工作空间</h2>
              <button
                type="button"
                onClick={() => setCreateWsOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">名称</label>
                <input
                  type="text"
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  placeholder="输入工作空间名称"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
                  onKeyDown={(e) => e.key === "Enter" && handleCreateWorkspace()}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreateWsOpen(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreateWorkspace}
                  className="px-4 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]"
                >
                  创建
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 邀请工作空间成员 Modal */}
      {inviteWsMemberOpen && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40"
          onClick={() => setInviteWsMemberOpen(false)}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6 text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">邀请成员</h2>
              <button
                type="button"
                onClick={() => setInviteWsMemberOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              被邀请的成员将自动加入该工作空间下的所有频道。
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">用户名</label>
                <input
                  type="text"
                  value={inviteWsIdentifier}
                  onChange={(e) => setInviteWsIdentifier(e.target.value)}
                  placeholder="输入用户名"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
                  onKeyDown={(e) => e.key === "Enter" && handleInviteWsMember()}
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setInviteWsMemberOpen(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleInviteWsMember}
                  className="px-4 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]"
                >
                  邀请
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 创建频道 Modal */}
      {createChannelOpen && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40"
          onClick={() => setCreateChannelOpen(false)}
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
                onClick={() => setCreateChannelOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">工作空间</label>
                <select
                  value={selectedWorkspaceId}
                  onChange={(e) => setSelectedWorkspaceId(e.target.value)}
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
                <label className="block text-sm font-medium text-gray-700 mb-1">频道名称</label>
                <input
                  type="text"
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  placeholder="输入频道名称"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
                  onKeyDown={(e) => e.key === "Enter" && handleCreateChannel()}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreateChannelOpen(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreateChannel}
                  className="px-4 py-2 bg-[#4A154B] text-white rounded-lg text-sm font-medium hover:bg-[#3d1040]"
                >
                  创建
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {addBotOpen && selectedId && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40" onClick={() => setAddBotOpen(false)} aria-modal="true" role="dialog">
          <div className="bg-white rounded-xl shadow-2xl max-w-xl w-full mx-4 p-6 text-left max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">管理频道 Bot</h2>
              <button type="button" onClick={() => setAddBotOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl" aria-label="关闭">×</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">已加入的 Bot</h3>
                {channelBots.length === 0 ? (
                  <p className="text-sm text-gray-400">暂无</p>
                ) : (
                  <ul className="space-y-1">
                    {channelBots.map((b) => (
                      <li key={b.member_id} className="flex items-center justify-between py-2 px-3 bg-[#F8F8F8] rounded-lg text-sm">
                        <span className="font-medium text-gray-800">@{b.username}</span>
                        <button type="button" onClick={() => removeBotFromChannel(b.member_id)} className="text-red-500 text-xs hover:text-red-700">移除</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">可添加的 Bot</h3>
                {(() => {
                  const inChannelIds = new Set(channelBots.map((c) => c.member_id));
                  const available = allBots.filter((b) => !inChannelIds.has(b.bot_id));
                  if (available.length === 0) return <p className="text-sm text-gray-400">暂无或已全部加入</p>;
                  return (
                    <ul className="space-y-1">
                      {available.map((b) => {
                        const checked = selectedBotIds.has(b.bot_id);
                        return (
                          <li
                            key={b.bot_id}
                            className={`flex items-start gap-2 py-2 px-3 rounded-lg text-sm cursor-pointer transition-colors select-none ${checked ? "bg-blue-50 border border-[#1264A3]/30" : "bg-[#F8F8F8] hover:bg-gray-100"}`}
                            onClick={() => setSelectedBotIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(b.bot_id)) next.delete(b.bot_id); else next.add(b.bot_id);
                              return next;
                            })}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 accent-[#1264A3] shrink-0"
                              checked={checked}
                              onChange={() => {}}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <div className="flex flex-col min-w-0">
                              <span className="font-medium text-gray-800">@{b.username}</span>
                              {introSummary(b.intro) && <span className="text-xs text-gray-500 truncate" title={b.intro}>{introSummary(b.intro)}</span>}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setAddBotOpen(false)} className="px-4 py-2 bg-[#F8F8F8] text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">关闭</button>
              {selectedBotIds.size > 0 && (
                <button
                  type="button"
                  disabled={addingBots}
                  onClick={async () => {
                    setAddingBots(true);
                    try {
                      await Promise.all([...selectedBotIds].map((id) => addBotToChannel(id)));
                      setSelectedBotIds(new Set());
                    } finally {
                      setAddingBots(false);
                    }
                  }}
                  className="px-4 py-2 bg-[#1264A3] text-white rounded-lg hover:bg-[#0f5a94] text-sm font-medium disabled:opacity-60"
                >
                  {addingBots ? "添加中…" : `添加选中 (${selectedBotIds.size})`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}


      {/* 好友管理面板 */}
      <FriendsPanel
        currentUserId={currentUserId}
        userToken={authToken ?? undefined}
        isOpen={friendsPanelOpen}
        onClose={() => setFriendsPanelOpen(false)}
      />

      {/* 频道成员管理模态框 */}
      {selectedId && (
        <ChannelMembersModal
          channelId={selectedId}
          channelName={selectedChannel?.name || ""}
          currentUserId={currentUserId}
          userToken={authToken ?? undefined}
          isOpen={manageMembersOpen}
          onClose={() => setManageMembersOpen(false)}
        />
      )}

      {/* 个人资料模态框 */}
      {userProfileOpen && currentUser && (
        <UserProfileModal
          currentUser={currentUser}
          userToken={authToken!}
          onClose={() => setUserProfileOpen(false)}
          onProfileUpdated={(data) => {
            const updated = { ...currentUser, display_name: data.display_name };
            setCurrentUser(updated);
            localStorage.setItem("currentUser", JSON.stringify({ user: updated, token: authToken, loginTime: Date.now() }));
          }}
        />
      )}

      {/* 频道资料模态框 */}
      {channelProfileOpen && currentUser && selectedId && (
        <ChannelProfileModal
          channelId={selectedId}
          channelName={selectedChannel?.name || ""}
          userToken={authToken!}
          onClose={() => setChannelProfileOpen(false)}
        />
      )}

      {/* Summary Modal */}
      {summaryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSummaryModalOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[680px] max-w-[95vw] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900 text-base">生成问答总结</h2>
              <button type="button" onClick={() => setSummaryModalOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                </svg>
              </button>
            </div>

            {/* QA pair list */}
            <div className="flex-1 overflow-auto px-5 py-3 space-y-2 min-h-0">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">{selectedPairs.length} / {blockPairsForExport.length} 组已选</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setSelectedQaIds(Object.fromEntries(blockPairsForExport.map((p) => [p.question.msg_id, true])))}
                    className="text-xs text-[#1264A3] hover:underline">全选</button>
                  <button type="button" onClick={() => setSelectedQaIds({})}
                    className="text-xs text-gray-400 hover:underline">取消全选</button>
                </div>
              </div>
              {blockPairsForExport.map((pair) => {
                const checked = !!selectedQaIds[pair.question.msg_id];
                const qText = stripThinkTags(parseGuidePayload(pair.question.content).text || pair.question.content);
                const aText = stripThinkTags(parseGuidePayload(pair.answer.content).text || pair.answer.content);
                const senderBot = channelBots.find((b) => b.member_id === pair.answer.sender_id);
                const botLabel = senderBot?.display_name || senderBot?.username || "Bot";
                return (
                  <label key={pair.question.msg_id}
                    className={`flex gap-3 p-3 rounded-xl border cursor-pointer transition-colors select-none ${checked ? "bg-blue-50 border-[#1264A3]/30" : "bg-gray-50 border-gray-200 hover:bg-gray-100"}`}>
                    <input type="checkbox" checked={checked}
                      onChange={() => setSelectedQaIds((prev) => ({ ...prev, [pair.question.msg_id]: !prev[pair.question.msg_id] }))}
                      className="mt-0.5 flex-shrink-0 accent-[#1264A3]" />
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-start gap-1.5">
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-medium flex-shrink-0">问</span>
                        <span className="text-[13px] text-gray-800 line-clamp-2">{qText}</span>
                      </div>
                      <div className="flex items-start gap-1.5">
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#2EB67D]/15 text-[#2EB67D] font-medium flex-shrink-0">{pair.answer.sender_type === "bot" ? botLabel : "答"}</span>
                        <span className="text-[13px] text-gray-500 line-clamp-2">{aText || "(无回复)"}</span>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            {/* Summary result */}
            {summaryPreview && (
              <div className="mx-5 mb-3 border border-gray-200 rounded-xl bg-gray-50 p-3 max-h-48 overflow-auto">
                <div className="text-xs font-medium text-gray-500 mb-1.5">总结结果</div>
                <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{summaryPreview}</div>
              </div>
            )}

            {/* Modal footer */}
            <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 gap-3">
              <div className="text-xs text-gray-400" title={qaLlmHint}>{qaLlmReady ? "✓ LLM 已就绪" : "⚠ LLM 未配置"}</div>
              <div className="flex gap-2">
                {summaryPreview && (
                  <button type="button" onClick={downloadQaMarkdown} disabled={selectedPairs.length === 0}
                    className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:border-gray-400 disabled:opacity-40 transition-colors">
                    导出 MD
                  </button>
                )}
                <button type="button" onClick={() => generateQaSummary(selectedPairs)} disabled={selectedPairs.length === 0 || summaryBusy || !qaLlmReady}
                  className="px-4 py-1.5 rounded-lg bg-[#1264A3] text-white text-sm font-medium hover:bg-[#0d4f82] disabled:opacity-40 transition-colors">
                  {summaryBusy ? "生成中…" : "生成总结"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex min-w-0">
      <main
        className="flex-1 flex flex-col min-w-0 bg-white relative"
        onDragEnter={(e) => {
          if (!selectedId || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragCounterRef.current += 1;
          if (dragCounterRef.current === 1) setIsDraggingOver(true);
        }}
        onDragOver={(e) => {
          if (!selectedId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragCounterRef.current -= 1;
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDraggingOver(false);
          }
        }}
        onDrop={async (e) => {
          e.preventDefault();
          dragCounterRef.current = 0;
          setIsDraggingOver(false);
          if (!selectedId) return;
          const files = Array.from(e.dataTransfer.files);
          for (const file of files) {
            await uploadFileObject(file);
          }
        }}
      >
        {/* ── 拖放叠加层 ───────────────────────────────────────────── */}
        {isDraggingOver && selectedId && (
          <>
            <style>{`
              @keyframes charColorCycle {
                0%   { color: hsl(270,75%,60%); }
                14%  { color: hsl(330,80%,60%); }
                28%  { color: hsl(10, 85%,60%); }
                42%  { color: hsl(35, 92%,52%); }
                56%  { color: hsl(60, 88%,46%); }
                70%  { color: hsl(130,65%,48%); }
                84%  { color: hsl(200,72%,50%); }
                92%  { color: hsl(230,75%,60%); }
                100% { color: hsl(270,75%,60%); }
              }
              @keyframes dropIconBounce {
                0%,100% { transform: translateY(0px); }
                50%     { transform: translateY(12px); }
              }
              .drag-overlay-char {
                display: inline-block;
                animation: charColorCycle 3.5s linear infinite;
                font-weight: 900;
                letter-spacing: 0.04em;
              }
            `}</style>
            <div
              className="absolute inset-0 z-50 flex flex-col items-center justify-center select-none pointer-events-none"
              style={{ backdropFilter: "blur(8px)", backgroundColor: "rgba(255,255,255,0.65)" }}
            >
              <div style={{ animation: "dropIconBounce 1.3s ease-in-out infinite" }} className="mb-7">
                <svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="10" y="6" width="38" height="48" rx="5" fill="#EEF2FF" stroke="#818CF8" strokeWidth="2.5"/>
                  <path d="M48 6 L48 18 L60 18Z" fill="#818CF8"/>
                  <rect x="22" y="6" width="30" height="48" rx="5" fill="#E0F2FE" stroke="#38BDF8" strokeWidth="2.5" transform="rotate(-6 22 6)"/>
                  <rect x="18" y="10" width="30" height="48" rx="5" fill="#F0FDF4" stroke="#4ADE80" strokeWidth="2.5" transform="rotate(-12 18 10)"/>
                  <path d="M36 54 L36 40 M36 54 L29 47 M36 54 L43 47" stroke="#6366F1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="text-5xl mb-5" style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}>
                {"可拖拽文件到此处".split("").map((char, i) => (
                  <span key={i} className="drag-overlay-char" style={{ animationDelay: `${-(i / 8) * 3.5}s` }}>
                    {char}
                  </span>
                ))}
              </div>
              <p className="text-sm text-gray-400 text-center leading-relaxed">
                图片：PNG、JPG、JPEG、WEBP、GIF<br />
                文档：PDF、TXT、MD、DOCX、XLSX
              </p>
            </div>
          </>
        )}

        {selectedId ? (
          <>
            {/* Channel header */}
            <div className="px-5 py-3 border-b border-gray-100 bg-white flex items-center gap-3">
              <span className="text-gray-400 font-medium text-base select-none">#</span>
              <h1 className="font-semibold text-gray-900 text-base truncate flex-1">{selectedChannel?.name || ""}</h1>
              {/* Auto-assist toggle */}
              <label className="flex items-center gap-1.5 cursor-pointer select-none" title={autoAssist ? "自动调用内置助手（开启中）" : "自动调用内置助手（关闭）"}>
                <span className="text-xs text-gray-500 whitespace-nowrap">自动接管</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoAssist}
                  onClick={() => {
                    const next = !autoAssist;
                    setAutoAssist(next);
                    fetch(`${API}/channels/${selectedId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ auto_assist: next }),
                    })
                      .then((r) => r.json())
                      .then((d) => {
                        if (d.data) {
                          setChannels((prev) => prev.map((c) => c.channel_id === selectedId ? { ...c, auto_assist: d.data.auto_assist } : c));
                        }
                      })
                      .catch(() => setAutoAssist(!next));
                  }}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${autoAssist ? "bg-[#1264A3]" : "bg-gray-200"}`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${autoAssist ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                </button>
              </label>
              {blockPairsForExport.length > 0 && (
                <button
                  type="button"
                  title="生成问答总结"
                  onClick={() => {
                    setSelectedQaIds(Object.fromEntries(blockPairsForExport.map((p) => [p.question.msg_id, true])));
                    setSummaryPreview("");
                    setSummaryModalOpen(true);
                  }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  {/* document-text / notes icon */}
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M4 4a2 2 0 0 1 2-2h4.586A2 2 0 0 1 12 2.586L15.414 6A2 2 0 0 1 16 7.414V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Zm2 6a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 6 10Zm.75 2.25a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Z" clipRule="evenodd" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => setMemoryPanelOpen((o) => !o)}
                title="频道记忆"
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
                  memoryPanelOpen ? "bg-[#1264A3] text-white" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                }`}
              >
                {/* brain icon */}
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path d="M13 3a1 1 0 0 1 1-1 6 6 0 0 1 6 6c0 1.08-.29 2.09-.8 2.96A4 4 0 0 1 20 14a4 4 0 0 1-2.22 3.57c.14.43.22.89.22 1.43a1 1 0 1 1-2 0c0-.5-.1-.95-.27-1.37A4 4 0 0 1 14 14v-1h-1v8a1 1 0 1 1-2 0v-8h-1v1a4 4 0 0 1-1.73 3.63C8.1 18.05 8 18.5 8 19a1 1 0 1 1-2 0c0-.54.08-1 .22-1.43A4 4 0 0 1 4 14a4 4 0 0 1 .8-2.96A6 6 0 0 1 4 8a6 6 0 0 1 6-6 1 1 0 1 1 0 2 4 4 0 0 0-4 4c0 .78.22 1.5.6 2.12A4 4 0 0 1 8 14v-1H7a1 1 0 1 1 0-2h1v-1a2 2 0 1 1 4 0v1h1a1 1 0 1 1 0 2h-1v1a4 4 0 0 1 .4-1.88A4 4 0 0 0 16 8a4 4 0 0 0-3-3.87V10a1 1 0 1 1-2 0V3Z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setManageMembersOpen(true)}
                title="成员管理"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM1.49 15.326a.78.78 0 0 1-.358-.442 3 3 0 0 1 4.308-3.516 6.484 6.484 0 0 0-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 0 1-2.07-.655ZM16.44 15.98a4.97 4.97 0 0 0 2.07-.654.78.78 0 0 0 .357-.442 3 3 0 0 0-4.308-3.517 6.484 6.484 0 0 1 1.907 3.96 2.32 2.32 0 0 1-.026.654ZM18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.304 16.19a.844.844 0 0 1-.277-.71 5 5 0 0 1 9.947 0 .843.843 0 0 1-.277.71A6.975 6.975 0 0 1 10 18a6.974 6.974 0 0 1-4.696-1.81Z" />
                </svg>
              </button>
              {currentUser && (
                <button
                  type="button"
                  onClick={() => setChannelProfileOpen(true)}
                  title="我的频道资料"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z" />
                  </svg>
                </button>
              )}
            </div>

            <div ref={messagesContainerRef} className="flex-1 overflow-auto">
              {loading ? (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm">加载中...</div>
              ) : (
                <div className="py-2 px-2">
                  {threadRoots.map((m) => {
                    const replies = threadRepliesOf(m.msg_id);

                    // ── helpers shared by root & replies ──────────────────
                    const replyIcon = (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path fillRule="evenodd" d="M1.22 6.53a.75.75 0 0 1 0-1.06l3-3a.75.75 0 0 1 1.06 1.06L3.56 5.25H10a5.75 5.75 0 0 1 0 11.5H6a.75.75 0 0 1 0-1.5h4a4.25 4.25 0 0 0 0-8.5H3.56l1.72 1.72a.75.75 0 1 1-1.06 1.06l-3-3Z" clipRule="evenodd" />
                      </svg>
                    );

                    // ── root message ───────────────────────────────────────
                    const revealedContent = revealedSecrets[m.msg_id];
                    const effectiveContent = m.is_secret ? (revealedContent ?? m.content) : m.content;
                    const { text, form, clarify } = parseGuidePayload(effectiveContent);
                    const clarifyAnswered = !!clarify && messages.some(
                      (r) => r.in_reply_to_msg_id === m.msg_id && isClarifyReplyUserMessage(r.content)
                    );
                    const clarifyWaiting = pendingClarifyReplyMsgId === m.msg_id;
                    const clarifyStatus: "form" | "waiting" | "answered" | null =
                      clarify && m.sender_type === "bot"
                        ? clarifyWaiting ? "waiting" : clarifyAnswered ? "answered" : "form"
                        : null;
                    const displayContent = isClarifyReplyUserMessage(effectiveContent)
                      ? effectiveContent.replace(/^@(?:channel bot|引导)\s*澄清回答[：:]\s*/i, "").trim()
                      : (text || effectiveContent);
                    const isOwn = m.sender_type === "user" && m.sender_id === currentUserId;
                    const senderBot = m.sender_type === "bot" ? channelBots.find((b) => b.member_id === m.sender_id) : undefined;
                    const botLabel = senderBot?.display_name || senderBot?.username || "Bot";
                    const botInitials = botLabel.slice(0, 2).toUpperCase();
                    const msgTime = m.created_at
                      ? new Date(m.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
                      : "";

                    const secretSecsLeft = (m.is_secret && !revealedContent && m.created_at)
                      ? Math.max(0, 60 - Math.floor((secretNow - new Date(m.created_at).getTime()) / 1000))
                      : null;
                    const isSecretExpired = secretSecsLeft !== null && secretSecsLeft <= 0;
                    const isSecretUnrevealed = m.is_secret && !revealedContent && !isSecretExpired;
                    const rootBubble = isOwn ? (
                      <div id={`msg-${m.msg_id}`} className="group flex flex-row-reverse items-end gap-2.5 px-4 py-1 transition-all">
                        <div className="w-8 h-8 rounded-xl bg-[#1264A3] flex items-center justify-center text-white text-xs font-bold select-none flex-shrink-0">我</div>
                        <div className="flex items-end gap-1.5">
                          <button type="button" title="回复" onClick={() => { setReplyingTo(m); (secretMode ? secretInputRef.current : inputRef.current)?.focus(); }}
                            className="opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 flex-shrink-0 mb-1">
                            {replyIcon}
                          </button>
                          <div className="flex flex-col items-end max-w-[72%]">
                            <span className="text-[11px] text-gray-400 mb-1 mr-0.5">{msgTime}</span>
                            {renderFileAttachments(m, true)}
                            <div className={`${isSecretUnrevealed ? "bg-amber-500" : isSecretExpired ? "bg-gray-400" : "bg-[#1264A3]"} text-white rounded-2xl rounded-tr-sm px-3.5 py-2 text-[14px] leading-relaxed break-words`}>
                              {isSecretExpired ? (
                                <span className="opacity-80">🔒 加密消息（已过期）</span>
                              ) : isSecretUnrevealed ? (
                                <div className="flex items-center gap-2">
                                  <span>🔒 加密消息</span>
                                  {secretSecsLeft !== null && <span className="text-[11px] opacity-70 tabular-nums">{secretSecsLeft}s</span>}
                                  {secretTokens[m.msg_id] && <button type="button" onClick={() => {
                                    fetch(`${API}/channels/${selectedId}/messages/${m.msg_id}/secret?token=${encodeURIComponent(secretTokens[m.msg_id])}`, {
                                      headers: { Authorization: `Bearer ${authToken}` },
                                    })
                                      .then((r) => r.json())
                                      .then((d) => {
                                        if (d.data?.content) {
                                          setRevealedSecrets((prev) => ({ ...prev, [m.msg_id]: d.data.content }));
                                        } else {
                                          alert(d.detail || "无法查看加密内容");
                                        }
                                      })
                                      .catch(() => alert("请求失败"));
                                  }}
                                    className="text-[12px] underline opacity-80 hover:opacity-100">查看</button>}
                                </div>
                              ) : (() => {
                                const q = parseQuotePrefix(displayContent);
                                if (q) return (
                                  <>
                                    <div className="border-l-2 border-white/50 pl-2 mb-2 text-[12px] leading-snug opacity-80">
                                      <span className="font-semibold block">{q.label}</span>
                                      <span className="block line-clamp-2">{q.quote}</span>
                                    </div>
                                    <div className="whitespace-pre-wrap">{q.rest.replace(/!\[.*?\]\(.*?\)\s*/g, "").trim() || q.rest}</div>
                                  </>
                                );
                                return <span className="whitespace-pre-wrap">{displayContent.replace(/!\[.*?\]\(.*?\)\s*/g, "").trim() || displayContent}</span>;
                              })()}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div id={`msg-${m.msg_id}`} className="group flex items-start gap-2.5 px-4 py-1 transition-all">
                        <div className="flex-shrink-0 mt-0.5">
                          {m.sender_type === "bot" ? (
                            senderBot?.avatar_url
                              ? <img src={senderBot.avatar_url} alt={botLabel} className="w-8 h-8 rounded-xl object-cover" />
                              : <div className="w-8 h-8 rounded-xl bg-[#2EB67D] flex items-center justify-center text-white text-xs font-bold select-none">{botInitials}</div>
                          ) : (
                            <div className="w-8 h-8 rounded-xl bg-gray-400 flex items-center justify-center text-white text-xs font-bold select-none">U</div>
                          )}
                        </div>
                        <div className="flex flex-col max-w-[72%]">
                          <div className="flex items-baseline gap-1.5 mb-1">
                            <span className="font-semibold text-[13px] text-gray-900 leading-none">{m.sender_type === "bot" ? botLabel : "用户"}</span>
                            {m.sender_type === "bot" && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[#2EB67D]/10 text-[#2EB67D] font-medium leading-none">Bot</span>}
                            <span className="text-[11px] text-gray-400 leading-none">{msgTime}</span>
                          </div>
                          {renderFileAttachments(m)}
                          <div className={`${isSecretExpired ? "bg-gray-100" : isSecretUnrevealed ? "bg-amber-100" : "bg-gray-100"} rounded-2xl rounded-tl-sm px-3.5 py-2 text-[14px] leading-relaxed text-gray-800`}>
                            {isSecretExpired ? (
                              <span className="text-gray-400">🔒 加密消息（已过期）</span>
                            ) : isSecretUnrevealed ? (
                              <div className="flex items-center gap-2 text-amber-700">
                                <span>🔒 加密消息</span>
                                {secretSecsLeft !== null && <span className="text-[11px] opacity-70 tabular-nums">{secretSecsLeft}s</span>}
                                {secretTokens[m.msg_id] && <button type="button" onClick={() => {
                                  fetch(`${API}/channels/${selectedId}/messages/${m.msg_id}/secret?token=${encodeURIComponent(secretTokens[m.msg_id])}`, {
                                    headers: { Authorization: `Bearer ${authToken}` },
                                  })
                                    .then((r) => r.json())
                                    .then((d) => {
                                      if (d.data?.content) {
                                        setRevealedSecrets((prev) => ({ ...prev, [m.msg_id]: d.data.content }));
                                      } else {
                                        alert(d.detail || "无法查看加密内容");
                                      }
                                    })
                                    .catch(() => alert("请求失败"));
                                }}
                                  className="text-[12px] underline opacity-80 hover:opacity-100">查看</button>}
                              </div>
                            ) : m._streaming && !text
                              ? <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                              : renderWithThinkFolding(text, `${m.msg_id}-`, !!m._streaming, (src) => { setLightboxSrc(src); const m2 = src.match(/\/files\/([^/]+)\/preview/); setLightboxFileId(m2 ? m2[1] : null); }, (url, name) => setFilePreviewPanel({ url, filename: name }))}
                            {!isSecretUnrevealed && m._streaming && !!text && <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />}
                          </div>
                          {form && selectedId && m.sender_type === "bot" && (
                            <GuideFormBlock msgId={m.msg_id} form={form} channelId={selectedId}
                              onReply={(newMsg) => setMessages((prev) => [...prev, newMsg])}
                              onChannelsRefresh={() => refreshChannels(setChannels, authToken ?? undefined)}
                              userToken={authToken ?? undefined} />
                          )}
                          {clarifyStatus !== null && selectedId && (
                            <ClarifyInlineBlock msgId={m.msg_id} schema={clarify!} status={clarifyStatus}
                              replyContent={undefined}
                              onContinue={(answers) => handleClarifyContinue(m.msg_id, clarify!, answers)}
                              onSkip={() => handleClarifySkip(m.msg_id)} />
                          )}
                        </div>
                        <button type="button" title="回复" onClick={() => { setReplyingTo(m); (secretMode ? secretInputRef.current : inputRef.current)?.focus(); }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity self-center w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex-shrink-0">
                          {replyIcon}
                        </button>
                      </div>
                    );

                    // ── thread replies (collapsible) ──────────────────────
                    const isExpanded = expandedThreads.has(m.msg_id);
                    const threadSection = replies.length > 0 ? (
                      <div className="ml-12 mb-1">
                        {/* Collapsed summary */}
                        {!isExpanded && (
                          <button
                            type="button"
                            onClick={() => toggleThread(m.msg_id)}
                            className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-gray-100 transition-colors group/th text-left"
                          >
                            {(() => {
                              const last = replies[replies.length - 1];
                              const { text: lt } = parseGuidePayload(last.content);
                              const preview = (isClarifyReplyUserMessage(last.content)
                                ? last.content.replace(/^@(?:channel bot|引导)\s*澄清回答[：:]\s*/i, "").trim()
                                : (lt || last.content)
                              ).replace(/\s+/g, " ").slice(0, 10);
                              return (
                                <>
                                  <span className="text-[12px] font-medium text-[#1264A3] group-hover/th:underline">
                                    {replies.length} 条回复
                                  </span>
                                  {preview && (
                                    <span className="text-[12px] text-gray-400 truncate max-w-[120px]">
                                      {preview}{(lt || last.content).length > 10 ? "…" : ""}
                                    </span>
                                  )}
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-gray-400">
                                    <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                                  </svg>
                                </>
                              );
                            })()}
                          </button>
                        )}
                        {/* Expanded replies */}
                        {isExpanded && (
                        <div className="pl-3 border-l-2 border-gray-200 flex flex-col gap-0.5">
                        {replies.map((r) => {
                          const rIsOwn = r.sender_type === "user" && r.sender_id === currentUserId;
                          const rBot = r.sender_type === "bot" ? channelBots.find((b) => b.member_id === r.sender_id) : undefined;
                          const rLabel = rBot ? (rBot.display_name || rBot.username || "Bot") : (rIsOwn ? "我" : "用户");
                          const rInitials = rLabel.slice(0, 2).toUpperCase();
                          const rTime = r.created_at ? new Date(r.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
                          const { text: rTextRaw, form: rForm, clarify: rClarify } = parseGuidePayload(r.content);
                          const rDisplay = isClarifyReplyUserMessage(r.content)
                            ? r.content.replace(/^@(?:channel bot|引导)\s*澄清回答[：:]\s*/i, "").trim()
                            : (rTextRaw || r.content);
                          const rClarifyAnswered = !!rClarify && messages.some(
                            (x) => x.in_reply_to_msg_id === r.msg_id && isClarifyReplyUserMessage(x.content)
                          );
                          const rClarifyWaiting = pendingClarifyReplyMsgId === r.msg_id;
                          const rClarifyStatus: "form" | "waiting" | "answered" | null =
                            rClarify && r.sender_type === "bot"
                              ? rClarifyWaiting ? "waiting" : rClarifyAnswered ? "answered" : "form"
                              : null;
                          // Show "↩ name" if replying to a non-root message
                          const rDirectParent = r.in_reply_to_msg_id !== m.msg_id
                            ? messages.find((x) => x.msg_id === r.in_reply_to_msg_id)
                            : null;
                          const rParentBot = rDirectParent?.sender_type === "bot"
                            ? channelBots.find((b) => b.member_id === rDirectParent.sender_id)
                            : null;
                          const rParentLabel = rDirectParent
                            ? (rDirectParent.sender_type === "bot"
                                ? (rParentBot?.display_name || rParentBot?.username || "Bot")
                                : (rDirectParent.sender_id === currentUserId ? "我" : "用户"))
                            : null;

                          const rCollapsed = collapsedMessages.has(r.msg_id);
                          const rPreview = rDisplay.replace(/\s+/g, " ").slice(0, 10) + (rDisplay.length > 10 ? "…" : "");
                          return (
                            <div key={r.msg_id} id={`msg-${r.msg_id}`} className="group/tr flex items-start gap-2 py-1">
                              {r.sender_type === "bot" ? (
                                rBot?.avatar_url
                                  ? <img src={rBot.avatar_url} alt={rLabel} className="w-6 h-6 rounded-lg object-cover flex-shrink-0 mt-0.5" />
                                  : <div className="w-6 h-6 rounded-lg bg-[#2EB67D] flex items-center justify-center text-white text-[10px] font-bold select-none flex-shrink-0 mt-0.5">{rInitials}</div>
                              ) : (
                                <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-white text-[10px] font-bold select-none flex-shrink-0 mt-0.5 ${rIsOwn ? "bg-[#1264A3]" : "bg-gray-400"}`}>
                                  {rIsOwn ? "我" : "U"}
                                </div>
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-baseline gap-1.5 mb-0.5 flex-wrap">
                                  <span className="font-semibold text-[12px] text-gray-900">{rLabel}</span>
                                  {r.sender_type === "bot" && <span className="text-[9px] px-1 py-0.5 rounded bg-[#2EB67D]/10 text-[#2EB67D] font-medium">Bot</span>}
                                  <span className="text-[11px] text-gray-400">{rTime}</span>
                                  {rParentLabel && (
                                    <span className="text-[11px] text-gray-400">↩ <span className="font-medium text-gray-500">{rParentLabel}</span></span>
                                  )}
                                  {rCollapsed && (
                                    <span className="text-[11px] text-gray-400 truncate max-w-[120px]">{rPreview}</span>
                                  )}
                                  <button type="button" onClick={() => toggleMessage(r.msg_id)}
                                    className="opacity-0 group-hover/tr:opacity-100 transition-opacity ml-0.5 flex items-center justify-center w-4 h-4 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex-shrink-0"
                                    title={rCollapsed ? "展开" : "折叠"}>
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                                      {rCollapsed
                                        ? <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                                        : <path fillRule="evenodd" d="M11.78 9.78a.75.75 0 0 1-1.06 0L8 7.06 5.28 9.78a.75.75 0 0 1-1.06-1.06l3.25-3.25a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06Z" clipRule="evenodd" />
                                      }
                                    </svg>
                                  </button>
                                </div>
                                {!rCollapsed && (
                                  <>
                                    {renderFileAttachments(r)}
                                    <div className={`rounded-xl px-2.5 py-1.5 text-[13px] leading-relaxed ${rIsOwn ? "bg-[#1264A3]/10 text-gray-800 whitespace-pre-wrap break-words" : "bg-gray-50 border border-gray-200 text-gray-800"}`}>
                                      {r._streaming && !rTextRaw
                                        ? <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                                        : renderWithThinkFolding(rDisplay, `${r.msg_id}-t-`, !!r._streaming, (src) => { setLightboxSrc(src); const m2 = src.match(/\/files\/([^/]+)\/preview/); setLightboxFileId(m2 ? m2[1] : null); }, (url, name) => setFilePreviewPanel({ url, filename: name }))}
                                      {r._streaming && !!rTextRaw && <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />}
                                    </div>
                                    {rForm && selectedId && r.sender_type === "bot" && (
                                      <GuideFormBlock msgId={r.msg_id} form={rForm} channelId={selectedId}
                                        onReply={(newMsg) => setMessages((prev) => [...prev, newMsg])}
                                        onChannelsRefresh={() => refreshChannels(setChannels, authToken ?? undefined)}
                                        userToken={authToken ?? undefined} />
                                    )}
                                    {rClarifyStatus !== null && selectedId && (
                                      <ClarifyInlineBlock msgId={r.msg_id} schema={rClarify!} status={rClarifyStatus}
                                        replyContent={undefined}
                                        onContinue={(answers) => handleClarifyContinue(r.msg_id, rClarify!, answers)}
                                        onSkip={() => handleClarifySkip(r.msg_id)} />
                                    )}
                                  </>
                                )}
                              </div>
                              <button type="button" title="回复" onClick={() => { setReplyingTo(r); (secretMode ? secretInputRef.current : inputRef.current)?.focus(); }}
                                className="opacity-0 group-hover/tr:opacity-100 transition-opacity self-center w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex-shrink-0">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                                  <path fillRule="evenodd" d="M1.22 6.53a.75.75 0 0 1 0-1.06l3-3a.75.75 0 0 1 1.06 1.06L3.56 5.25H10a5.75 5.75 0 0 1 0 11.5H6a.75.75 0 0 1 0-1.5h4a4.25 4.25 0 0 0 0-8.5H3.56l1.72 1.72a.75.75 0 1 1-1.06 1.06l-3-3Z" clipRule="evenodd" />
                                </svg>
                              </button>
                            </div>
                          );
                        })}
                          <button
                            type="button"
                            onClick={() => toggleThread(m.msg_id)}
                            className="mt-0.5 flex items-center gap-1 px-1 py-0.5 text-[11px] text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 transition-colors"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                              <path fillRule="evenodd" d="M11.78 9.78a.75.75 0 0 1-1.06 0L8 7.06 5.28 9.78a.75.75 0 0 1-1.06-1.06l3.25-3.25a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06Z" clipRule="evenodd" />
                            </svg>
                            收起
                          </button>
                        </div>
                        )}
                      </div>
                    ) : null;

                    return (
                      <div key={m.msg_id}>
                        {rootBubble}
                        {threadSection}
                      </div>
                    );
                  })}
                  {waitingForBotReply && <ThinkingIndicator />}
                  {Object.entries(processingBots).map(([botId, username]) => (
                    <div key={botId} className="flex gap-3 px-3 py-2">
                      <div className="w-9 h-9 rounded-xl bg-[#2EB67D]/20 flex items-center justify-center text-[#2EB67D] text-sm font-bold flex-shrink-0">
                        {username.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className="font-semibold text-[14px] text-gray-900">{username}</span>
                          <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-[#2EB67D]/10 text-[#2EB67D] font-medium">Bot</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-[13px] text-gray-400">
                          <span className="inline-flex gap-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: "0ms" }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: "150ms" }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: "300ms" }} />
                          </span>
                          正在输入...
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Input area */}
            <div className="flex-shrink-0 px-4 pb-4 pt-2">
              {/* Reply bar */}
              {replyingTo && (() => {
                const refBot = replyingTo.sender_type === "bot" ? channelBots.find((b) => b.member_id === replyingTo.sender_id) : null;
                const refLabel = replyingTo.sender_type === "bot" ? (refBot?.display_name || refBot?.username || "Bot") : "我";
                const refPreview = (parseGuidePayload(replyingTo.content).text || replyingTo.content).replace(/\n/g, " ").slice(0, 80);
                return (
                  <div className="flex items-center gap-2 px-3 py-2 mb-1 bg-gray-50 border border-gray-200 rounded-xl text-[13px]">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-[#1264A3] flex-shrink-0">
                      <path fillRule="evenodd" d="M1.22 6.53a.75.75 0 0 1 0-1.06l3-3a.75.75 0 0 1 1.06 1.06L3.56 5.25H10a5.75 5.75 0 0 1 0 11.5H6a.75.75 0 0 1 0-1.5h4a4.25 4.25 0 0 0 0-8.5H3.56l1.72 1.72a.75.75 0 1 1-1.06 1.06l-3-3Z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-500">回复</span>
                    <span className="font-semibold text-gray-700">{refLabel}</span>
                    <span className="text-gray-400 truncate flex-1">{refPreview}{(parseGuidePayload(replyingTo.content).text || replyingTo.content).length > 80 ? "…" : ""}</span>
                    <button type="button" onClick={() => setReplyingTo(null)} className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                        <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                      </svg>
                    </button>
                  </div>
                );
              })()}
              {pendingFileNames.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {pendingFileNames.map((name, i) => {
                    const preview = pendingFilePreviews[i] ?? null;
                    const removeItem = () => {
                      if (preview) URL.revokeObjectURL(preview);
                      setPendingFileIds((p) => p.filter((_, j) => j !== i));
                      setPendingFileNames((p) => p.filter((_, j) => j !== i));
                      setPendingFilePreviews((p) => p.filter((_, j) => j !== i));
                    };
                    return preview ? (
                      <div key={i} className="relative group cursor-pointer rounded-xl overflow-hidden border border-gray-200 shadow-sm inline-block">
                        <img src={preview} alt={name} className="max-w-[180px] max-h-[140px] object-cover block" />
                        <div className="px-2.5 py-1.5 bg-white text-[11px] text-gray-500 border-t border-gray-100 flex items-center gap-1.5 max-w-[180px]">
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-gray-400 flex-shrink-0">
                            <path fillRule="evenodd" d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm10.5 5.707a.5.5 0 0 0-.146-.353l-2.5-2.5a.5.5 0 0 0-.708 0L7.5 8.5 6.354 7.354a.5.5 0 0 0-.708 0l-3.146 3.15V12a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-2.293ZM11 5.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" clipRule="evenodd" />
                          </svg>
                          <span className="truncate">{name}</span>
                        </div>
                        <button
                          type="button"
                          onClick={removeItem}
                          className="absolute top-1 right-1 w-5 h-5 bg-black/50 text-white rounded-full text-[11px] leading-none items-center justify-center hidden group-hover:flex"
                        >×</button>
                      </div>
                    ) : (
                      <div key={i} className="relative group flex items-center gap-2.5 px-3 py-2.5 bg-white border border-gray-200 rounded-xl shadow-sm max-w-[240px]">
                        <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-blue-500">
                            <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 16 6.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-gray-700 truncate">{name}</div>
                          <div className="text-[11px] text-gray-400">待发送</div>
                        </div>
                        <button
                          type="button"
                          onClick={removeItem}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-500 text-white rounded-full text-[11px] leading-none items-center justify-center hidden group-hover:flex"
                        >×</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="relative">
              <div className="border border-gray-200 rounded-2xl overflow-hidden bg-white shadow-sm focus-within:border-gray-400 focus-within:shadow-md transition-all">
                <div>
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => {
                      const v = e.target.value;
                      const pos = e.target.selectionStart ?? v.length;
                      setInput(v);
                      if (!secretMode) {
                        const lastAt = v.lastIndexOf("@", pos - 1);
                        if (lastAt !== -1) {
                          const after = v.slice(lastAt + 1, pos);
                          if (!after.includes(" ") && !after.includes("\n")) {
                            const rect = e.target.getBoundingClientRect();
                            const spaceBelow = window.innerHeight - rect.bottom;
                            const spaceAbove = rect.top;
                            if (spaceBelow < 180 && spaceAbove > spaceBelow) {
                              setMentionDropdownPlacement("top");
                            } else {
                              setMentionDropdownPlacement("bottom");
                            }
                            setShowMentionDropdown(true);
                            setMentionFilter(after);
                            return;
                          }
                        }
                      }
                      setShowMentionDropdown(false);
                    }}
                    onKeyDown={(e) => {
                      if (showMentionDropdown && e.key === "Escape") {
                        setShowMentionDropdown(false);
                        return;
                      }
                      if (e.key === "Enter" && e.ctrlKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder={secretMode ? "输入加密内容（仅 Bot 可读取原文）…" : `发消息到 #${selectedChannel?.name || "频道"}，@ 呼叫 Bot…`}
                    className={`w-full px-4 pt-3 pb-2 min-h-[48px] max-h-48 resize-none outline-none text-[14px] placeholder-gray-400 bg-transparent ${secretMode ? "text-amber-700" : "text-gray-900"}`}
                    rows={1}
                  />
                </div>
                {/* Input toolbar */}
                <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100">
                  <div className="flex items-center gap-0.5">
                    {/* 上传文件和图片菜单 */}
                    <input ref={fileImgInputRef} type="file" accept=".txt,.md,.docx,.pdf,.xlsx,.png,.jpg,.jpeg,.webp,.gif" className="hidden" onChange={uploadFile} />
                    <div ref={uploadMenuRef} className="relative">
                      <button
                        type="button"
                        onClick={() => setUploadMenuOpen((o) => !o)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                        title="上传文件和图片"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4.5 h-4.5">
                          <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                        </svg>
                      </button>
                      {uploadMenuOpen && (
                        <div className="absolute bottom-10 left-0 z-50 bg-white border border-gray-200 rounded-xl shadow-lg py-1 min-w-[160px]">
                          <button
                            type="button"
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-gray-700 hover:bg-gray-50 rounded-lg"
                            onClick={() => { setUploadMenuOpen(false); fileImgInputRef.current?.click(); }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-gray-400 flex-shrink-0">
                              <path fillRule="evenodd" d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.242Z" clipRule="evenodd" />
                            </svg>
                            上传文件和图片
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSecretMode((v) => !v)}
                      title={secretMode ? "取消加密模式" : "开启加密模式（仅 Bot 可读原文）"}
                      className={`w-8 h-8 flex items-center justify-center rounded-lg text-base transition-colors ${
                        secretMode ? "bg-amber-100 text-amber-600 hover:bg-amber-200" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                      }`}
                    >🔒</button>
                    <span className="text-[12px] text-gray-400 hidden sm:inline select-none">Ctrl+Enter</span>
                    <button
                      type="button"
                      onClick={send}
                      className={`px-4 py-1.5 rounded-xl text-[13px] font-semibold transition-all ${
                        input.trim() || pendingFileIds.length > 0
                          ? secretMode ? "bg-amber-500 text-white hover:bg-amber-600 shadow-sm" : "bg-[#007a5a] text-white hover:bg-[#006a4d] shadow-sm"
                          : "bg-gray-100 text-gray-400 cursor-not-allowed"
                      }`}
                      disabled={!input.trim() && pendingFileIds.length === 0}
                    >
                      {secretMode ? "加密发送" : "发送"}
                    </button>
                  </div>
                </div>
              </div>
              {showMentionDropdown && (() => {
                const allItems = [
                  ...channelBots.map((b) => ({ ...b, kind: "bot" as const })),
                  ...channelUsers.map((u) => ({ ...u, kind: "user" as const })),
                ];
                const matched = allItems.filter((item) =>
                  item.username.toLowerCase().includes(mentionFilter.toLowerCase()) ||
                  (item.display_name ?? "").toLowerCase().includes(mentionFilter.toLowerCase())
                );
                if (matched.length === 0) return null;
                const placementClass = mentionDropdownPlacement === "top" ? "bottom-full mb-1" : "top-full mt-1";
                return (
                  <ul className={`absolute left-0 right-0 ${placementClass} bg-white border border-gray-200 rounded-lg shadow-lg z-20 max-h-48 overflow-auto`} role="listbox">
                    {matched.map((item) => (
                      <li
                        key={item.member_id}
                        role="option"
                        className="px-3 py-2 hover:bg-[#F8F8F8] cursor-pointer text-sm flex items-center gap-2"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          const el = inputRef.current;
                          if (!el) return;
                          const v = el.value;
                          const pos = el.selectionStart ?? v.length;
                          const lastAt = v.lastIndexOf("@", pos - 1);
                          const newVal = v.slice(0, lastAt) + "@" + item.username + " " + v.slice(pos);
                          setInput(newVal);
                          setShowMentionDropdown(false);
                          setTimeout(() => {
                            el.focus();
                            el.setSelectionRange(lastAt + item.username.length + 2, lastAt + item.username.length + 2);
                          }, 0);
                        }}
                      >
                        <div className={`w-6 h-6 rounded flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${item.kind === "bot" ? "bg-[#2EB67D]" : "bg-[#1264A3]"}`}>
                          {item.username.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-medium text-gray-800">@{item.username}</span>
                          {item.display_name && <span className="text-xs text-gray-400 truncate">{item.display_name}</span>}
                        </div>
                        <span className={`ml-auto text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${item.kind === "bot" ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-700"}`}>
                          {item.kind === "bot" ? "Bot" : "用户"}
                        </span>
                      </li>
                    ))}
                  </ul>
                );
              })()}
              </div>
            </div>

            {/* 文生图 / 图生图 Modal */}
            {imageGenOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                    <h3 className="text-[15px] font-semibold text-gray-800">AI 图片</h3>
                    <button type="button" onClick={() => setImageGenOpen(false)} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                      </svg>
                    </button>
                  </div>
                  {/* Tab 切换 */}
                  <div className="flex border-b border-gray-100">
                    <button type="button" onClick={() => setImageGenTab("gen")}
                      className={`flex-1 py-2.5 text-[13px] font-medium text-center transition-colors ${imageGenTab === "gen" ? "text-[#1264A3] border-b-2 border-[#1264A3]" : "text-gray-500 hover:text-gray-700"}`}>
                      文生图
                    </button>
                    <button type="button" onClick={() => setImageGenTab("edit")}
                      className={`flex-1 py-2.5 text-[13px] font-medium text-center transition-colors ${imageGenTab === "edit" ? "text-[#1264A3] border-b-2 border-[#1264A3]" : "text-gray-500 hover:text-gray-700"}`}>
                      图生图
                    </button>
                  </div>

                  {/* ─── 文生图 Tab ─── */}
                  {imageGenTab === "gen" && (
                    <>
                      <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
                        <div>
                          <label className="block text-[13px] font-medium text-gray-600 mb-1.5">描述词</label>
                          <textarea value={imageGenPrompt} onChange={(e) => setImageGenPrompt(e.target.value)}
                            placeholder="描述你想要生成的图片，例如：一只在星空下奔跑的白色猫咪"
                            className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[14px] resize-none outline-none focus:border-gray-400 min-h-[80px]" rows={3} />
                        </div>
                        <div className="flex gap-3">
                          <div className="flex-1">
                            <label className="block text-[13px] font-medium text-gray-600 mb-1.5">模型</label>
                            <select value={imageGenModel} onChange={(e) => setImageGenModel(e.target.value)}
                              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[13px] outline-none focus:border-gray-400 bg-white">
                              <option value="qwen-image-2.0-pro">qwen-image-2.0-pro (推荐)</option>
                              <option value="qwen-image-2.0-pro-2026-03-03">qwen-image-2.0-pro-2026-03-03</option>
                              <option value="qwen-image-2.0">qwen-image-2.0</option>
                              <option value="qwen-image-2.0-2026-03-03">qwen-image-2.0-2026-03-03</option>
                              <option value="qwen-image-max">qwen-image-max</option>
                              <option value="qwen-image-max-2025-12-30">qwen-image-max-2025-12-30</option>
                              <option value="qwen-image-plus-2026-01-09">qwen-image-plus-2026-01-09</option>
                              <option value="z-image-turbo">z-image-turbo (快速)</option>
                            </select>
                          </div>
                          <div className="flex-1">
                            <label className="block text-[13px] font-medium text-gray-600 mb-1.5">尺寸</label>
                            <select value={imageGenSize} onChange={(e) => setImageGenSize(e.target.value)}
                              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[13px] outline-none focus:border-gray-400 bg-white">
                              <option value="1024*1024">1024 x 1024</option>
                              <option value="720*1280">720 x 1280 (竖版)</option>
                              <option value="1280*720">1280 x 720 (横版)</option>
                              <option value="768*1024">768 x 1024</option>
                              <option value="1024*768">1024 x 768</option>
                            </select>
                          </div>
                        </div>
                      </div>
                      {/* 生成结果预览 — 固定在按钮栏上方，不在滚动区域内 */}
                      {imageGenPreview && (
                        <div className="px-5 py-3 border-t border-gray-100">
                          <div className="border border-gray-200 rounded-xl overflow-hidden">
                            <img src={`${API}/files/${imageGenPreview.file_id}/preview`} alt="AI generated" className="w-full max-h-[300px] object-contain bg-gray-50" />
                          </div>
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 bg-gray-50">
                        {imageGenPreview && (
                          <>
                          <button type="button" onClick={() => {
                            setImageEditSourceFileId(imageGenPreview.file_id);
                            setImageGenTab("edit");
                            setImageEditPreview(null);
                            setImageEditPrompt("");
                          }} className="px-4 py-1.5 rounded-xl text-[13px] font-semibold bg-gray-600 text-white hover:bg-gray-700 shadow-sm transition-all">
                            用此图编辑
                          </button>
                          <button type="button" onClick={async () => {
                            if (!selectedId || !imageGenPreview) return;
                            try {
                              const res = await fetch(`${API}/channels/${selectedId}/messages`, {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ content: `[AI 生成图片] ${imageGenPrompt}`, sender_id: currentUserId, sender_type: "user", file_ids: [imageGenPreview.file_id] }),
                              });
                              const d = await res.json();
                              if (!res.ok) { toast.error(d.detail || "发送失败"); return; }
                              if (d.data) setMessages((prev) => prev.some((m) => m.msg_id === d.data.msg_id) ? prev : [...prev, d.data]);
                              setImageGenOpen(false); setImageGenPreview(null); setImageGenPrompt("");
                            } catch { toast.error("发送失败"); }
                          }} className="px-4 py-1.5 rounded-xl text-[13px] font-semibold bg-[#007a5a] text-white hover:bg-[#006a4d] shadow-sm transition-all">
                            发送到频道
                          </button>
                          </>
                        )}
                        <button type="button" disabled={!imageGenPrompt.trim() || imageGenLoading} onClick={async () => {
                          if (!selectedId || !imageGenPrompt.trim()) return;
                          setImageGenLoading(true); setImageGenPreview(null);
                          try {
                            const res = await fetch(`${API}/images/generate`, {
                              method: "POST", headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ channel_id: selectedId, sender_id: currentUserId, prompt: imageGenPrompt.trim(), model: imageGenModel, size: imageGenSize }),
                            });
                            const data = await res.json();
                            if (!res.ok) { toast.error(data.detail || "图片生成失败"); return; }
                            setImageGenPreview({ file_id: data.data.file_id, preview_url: data.data.preview_url });
                          } catch (err) { toast.error("图片生成出错"); console.error(err); } finally { setImageGenLoading(false); }
                        }} className={`px-4 py-1.5 rounded-xl text-[13px] font-semibold transition-all ${imageGenPrompt.trim() && !imageGenLoading ? "bg-[#1264A3] text-white hover:bg-[#0e5a96] shadow-sm" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}>
                          {imageGenLoading ? "生成中..." : imageGenPreview ? "重新生成" : "生成"}
                        </button>
                      </div>
                    </>
                  )}

                  {/* ─── 图生图 Tab ─── */}
                  {imageGenTab === "edit" && (
                    <>
                      <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
                        {/* 源图片 */}
                        <div>
                          <label className="block text-[13px] font-medium text-gray-600 mb-1.5">源图片</label>
                          {imageEditSourceFileId ? (
                            <div className="relative border border-gray-200 rounded-xl overflow-hidden bg-gray-50">
                              <img src={`${API}/files/${imageEditSourceFileId}/preview`} alt="source" className="w-full max-h-[200px] object-contain" />
                              <button type="button" onClick={() => { setImageEditSourceFileId(""); setImageEditPreview(null); }}
                                className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center text-xs hover:bg-black/70">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                                  <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                                </svg>
                              </button>
                            </div>
                          ) : (
                            <div className="border-2 border-dashed border-gray-200 rounded-xl p-4 text-center text-gray-400 text-[13px] space-y-3">
                              {/* 从聊天中选择已有图片 */}
                              {(() => {
                                const imageFiles = messages.flatMap((m) => (m.files || []).filter((f) => (f.content_type || "").startsWith("image/")));
                                if (imageFiles.length > 0) {
                                  return (
                                    <div>
                                      <p className="text-gray-500 mb-2">从聊天中选择图片：</p>
                                      <div className="flex flex-wrap gap-2 justify-center">
                                        {imageFiles.slice(-8).map((f) => (
                                          <div key={f.file_id}
                                            className="w-16 h-16 rounded-lg border-2 border-gray-200 overflow-hidden cursor-pointer hover:border-blue-400 transition-colors"
                                            onClick={() => { setImageEditSourceFileId(f.file_id); setImageEditPreview(null); }}>
                                            <img src={`${API}/files/${f.file_id}/preview`} alt={f.original_filename || "image"} className="w-full h-full object-cover" />
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  );
                                }
                                return <p>当前频道暂无图片，请先上传或生成一张图片</p>;
                              })()}
                              <p className="text-[11px] text-gray-300">也可在聊天中点击图片放大后选择「编辑此图」</p>
                            </div>
                          )}
                        </div>
                        {/* 编辑提示词 */}
                        <div>
                          <label className="block text-[13px] font-medium text-gray-600 mb-1.5">编辑描述</label>
                          <textarea value={imageEditPrompt} onChange={(e) => setImageEditPrompt(e.target.value)}
                            placeholder="描述你想要如何编辑这张图片，例如：将背景改为夕阳海滩"
                            className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[14px] resize-none outline-none focus:border-gray-400 min-h-[80px]" rows={3} />
                        </div>
                        <div className="flex gap-3">
                          <div className="flex-1">
                            <label className="block text-[13px] font-medium text-gray-600 mb-1.5">模型</label>
                            <select value={imageEditModel} onChange={(e) => setImageEditModel(e.target.value)}
                              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[13px] outline-none focus:border-gray-400 bg-white">
                              <option value="qwen-image-edit-max">qwen-image-edit-max (推荐)</option>
                              <option value="qwen-image-edit-plus">qwen-image-edit-plus</option>
                            </select>
                          </div>
                          <div className="flex-1">
                            <label className="block text-[13px] font-medium text-gray-600 mb-1.5">尺寸</label>
                            <select value={imageEditSize} onChange={(e) => setImageEditSize(e.target.value)}
                              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-[13px] outline-none focus:border-gray-400 bg-white">
                              <option value="1024*1024">1024 x 1024</option>
                              <option value="720*1280">720 x 1280 (竖版)</option>
                              <option value="1280*720">1280 x 720 (横版)</option>
                              <option value="768*1024">768 x 1024</option>
                              <option value="1024*768">1024 x 768</option>
                            </select>
                          </div>
                        </div>
                      </div>
                      {/* 编辑结果预览 — 固定在按钮栏上方，不在滚动区域内 */}
                      {imageEditPreview && (
                        <div className="px-5 py-3 border-t border-gray-100">
                          <label className="block text-[13px] font-medium text-gray-600 mb-1.5">编辑结果</label>
                          <div className="border border-gray-200 rounded-xl overflow-hidden">
                            <img src={`${API}/files/${imageEditPreview.file_id}/preview`} alt="edited" className="w-full max-h-[300px] object-contain bg-gray-50" />
                          </div>
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 bg-gray-50">
                        {imageEditPreview && (
                          <button type="button" onClick={async () => {
                            if (!selectedId || !imageEditPreview) return;
                            try {
                              const res = await fetch(`${API}/channels/${selectedId}/messages`, {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ content: `[AI 编辑图片] ${imageEditPrompt}`, sender_id: currentUserId, sender_type: "user", file_ids: [imageEditPreview.file_id] }),
                              });
                              const d = await res.json();
                              if (!res.ok) { toast.error(d.detail || "发送失败"); return; }
                              if (d.data) setMessages((prev) => prev.some((m) => m.msg_id === d.data.msg_id) ? prev : [...prev, d.data]);
                              setImageGenOpen(false); setImageEditPreview(null); setImageEditPrompt(""); setImageEditSourceFileId("");
                            } catch { toast.error("发送失败"); }
                          }} className="px-4 py-1.5 rounded-xl text-[13px] font-semibold bg-[#007a5a] text-white hover:bg-[#006a4d] shadow-sm transition-all">
                            发送到频道
                          </button>
                        )}
                        <button type="button"
                          disabled={!imageEditSourceFileId || !imageEditPrompt.trim() || imageEditLoading}
                          onClick={async () => {
                            if (!selectedId || !imageEditSourceFileId || !imageEditPrompt.trim()) return;
                            setImageEditLoading(true); setImageEditPreview(null);
                            try {
                              const res = await fetch(`${API}/images/edit`, {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ channel_id: selectedId, sender_id: currentUserId, source_file_id: imageEditSourceFileId, prompt: imageEditPrompt.trim(), model: imageEditModel, size: imageEditSize }),
                              });
                              const data = await res.json();
                              if (!res.ok) { toast.error(data.detail || "图片编辑失败"); return; }
                              setImageEditPreview({ file_id: data.data.file_id, preview_url: data.data.preview_url });
                            } catch (err) { toast.error("图片编辑出错"); console.error(err); } finally { setImageEditLoading(false); }
                          }}
                          className={`px-4 py-1.5 rounded-xl text-[13px] font-semibold transition-all ${imageEditSourceFileId && imageEditPrompt.trim() && !imageEditLoading ? "bg-[#1264A3] text-white hover:bg-[#0e5a96] shadow-sm" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}>
                          {imageEditLoading ? "编辑中..." : imageEditPreview ? "重新编辑" : "开始编辑"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-20 h-20 rounded-3xl bg-gray-100 flex items-center justify-center mb-5">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 text-gray-300">
                <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 0 1-3.476.383.39.39 0 0 0-.297.17l-2.755 4.133a.75.75 0 0 1-1.248 0l-2.755-4.133a.39.39 0 0 0-.297-.17 48.9 48.9 0 0 1-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97Z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-gray-700 text-[15px] font-semibold">选择一个频道</p>
            <p className="text-gray-400 text-[13px] mt-1.5">从左侧选择频道开始对话，或 <span className="text-[#1264A3]">创建新频道</span></p>
          </div>
        )}
      </main>

      {/* Memory right panel */}
      {memoryPanelOpen && selectedId && (
        <div className="relative flex-shrink-0 flex" style={{ width: memoryWidth }}>
          <div
            onMouseDown={onMemoryResize}
            className="absolute top-0 left-0 h-full w-1 cursor-col-resize hover:bg-gray-300 transition-colors z-10"
          />
          <MemoryPanel
            channelId={selectedId}
            channelName={selectedChannel?.name ?? ""}
            contextData={contextData}
            onSave={saveContextLayer}
            onDataChange={(layer, val) => setContextData((prev) => ({ ...prev, [layer.toLowerCase()]: val }))}
            onClose={() => setMemoryPanelOpen(false)}
          />
        </div>
      )}
      {/* File preview sidebar */}
      {filePreviewPanel && (
        <div className="relative flex-shrink-0 flex" style={{ width: filePreviewWidth }}>
          <div
            onMouseDown={onFilePreviewResize}
            className="absolute top-0 left-0 h-full w-1 cursor-col-resize hover:bg-gray-300 transition-colors z-10"
          />
          <FilePreviewSidebar
            url={filePreviewPanel.url}
            filename={filePreviewPanel.filename}
            onClose={() => setFilePreviewPanel(null)}
          />
        </div>
      )}
      </div>
    </div>

    {/* Lightbox 图片放大 */}
    {lightboxSrc && (
      <div
        className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center cursor-zoom-out"
        onClick={() => { setLightboxSrc(null); setLightboxFileId(null); }}
      >
        <button
          type="button"
          onClick={() => { setLightboxSrc(null); setLightboxFileId(null); }}
          className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-xl transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
        {lightboxFileId && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setImageEditSourceFileId(lightboxFileId);
              setImageGenTab("edit");
              setImageGenOpen(true);
              setLightboxSrc(null);
              setLightboxFileId(null);
            }}
            className="absolute top-4 left-4 flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-[13px] font-medium transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="m2.695 14.762-1.262 3.155a.5.5 0 0 0 .65.65l3.155-1.262a4 4 0 0 0 1.343-.886L17.5 5.501a2.121 2.121 0 0 0-3-3L3.58 13.42a4 4 0 0 0-.885 1.343Z" />
            </svg>
            编辑此图
          </button>
        )}
        <img
          src={lightboxSrc}
          alt="preview"
          className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl cursor-default"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    )}
    </>
  );
}
