/**
 * MemoryPage — 频道记忆全屏独立页面
 *
 * 特性：
 * - 左侧导航栏 + 右侧内容区的双栏布局
 * - 结构化层（ANCHOR/DECISIONS/PROGRESS）：卡片式条目 + Markdown 渲染 + 内联编辑器（写/预览双栏）
 * - FILES_INDEX：文件卡片网格（图标、类型、摘要）
 * - RECENT：时间线视图
 * - MEMBERS：成员卡片
 * - TODO：任务看板
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { isMemberOrAbove, isAdmin as isAdminRole, getStoredRole } from "./permissions";

const API = "/api/v1";

/* ── Types ─────────────────────────────────────────────────────────────────── */

type MemoryEntryItem = {
  entry_id: string;
  channel_id: string;
  layer: string;
  title: string | null;
  content: string;
  sort_order: number;
  created_by: string | null;
  creator_type: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type MemberItem = {
  member_id: string;
  member_type: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
};

type TodoItem = {
  todo_id: string;
  channel_id: string;
  creator_id: string;
  creator_type: string;
  assignee_id: string | null;
  assignee_type: string | null;
  content: string;
  status: string;
};

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function getStoredToken(): string | null {
  try {
    const stored = localStorage.getItem("currentUser");
    if (!stored) return null;
    const data = JSON.parse(stored);
    if (data.loginTime && Date.now() - data.loginTime < 86400000) {
      return data.token ?? data.user?.user_id ?? null;
    }
  } catch {}
  return null;
}

function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

/* ── Layer definitions ─────────────────────────────────────────────────────── */

const LAYERS = [
  "ANCHOR",
  "PROGRESS",
  "DECISIONS",
  "FILES_INDEX",
  "RECENT",
  "MEMBERS",
  "TODO",
] as const;

const LAYER_META: Record<
  string,
  {
    label: string;
    desc: string;
    icon: string;
    color: string;
    bgLight: string;
    borderColor: string;
    entryBased?: boolean;
    readonly?: boolean;
  }
> = {
  ANCHOR: {
    label: "项目锚点",
    desc: "核心目标、约束、背景",
    icon: "⚓",
    color: "text-blue-600",
    bgLight: "bg-blue-50",
    borderColor: "border-blue-200",
    entryBased: true,
  },
  PROGRESS: {
    label: "项目进度",
    desc: "当前进度、已完成、下一步",
    icon: "📈",
    color: "text-teal-600",
    bgLight: "bg-teal-50",
    borderColor: "border-teal-200",
    entryBased: true,
  },
  DECISIONS: {
    label: "决策记录",
    desc: "重要决策及原因",
    icon: "📋",
    color: "text-purple-600",
    bgLight: "bg-purple-50",
    borderColor: "border-purple-200",
    entryBased: true,
  },
  FILES_INDEX: {
    label: "资料索引",
    desc: "上传的文件与参考资料",
    icon: "🗂️",
    color: "text-amber-600",
    bgLight: "bg-amber-50",
    borderColor: "border-amber-200",
    readonly: true,
  },
  RECENT: {
    label: "近期动态",
    desc: "历史对话摘要",
    icon: "🕐",
    color: "text-green-600",
    bgLight: "bg-green-50",
    borderColor: "border-green-200",
    readonly: true,
  },
  MEMBERS: {
    label: "频道成员",
    desc: "用户与 Bot 能力一览",
    icon: "👥",
    color: "text-gray-600",
    bgLight: "bg-gray-50",
    borderColor: "border-gray-200",
    readonly: true,
  },
  TODO: {
    label: "待办事项",
    desc: "频道任务清单",
    icon: "✅",
    color: "text-rose-600",
    bgLight: "bg-rose-50",
    borderColor: "border-rose-200",
    readonly: true,
  },
};

/* ── File card helper: parse FILES_INDEX markdown into cards ────────────── */

type FileCard = {
  filename: string;
  fileId: string;
  contentType: string;
  summary: string;
  time: string;
};

function parseFilesIndex(md: string): FileCard[] {
  if (!md.trim()) return [];
  const blocks = md
    .split(/\n---\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const filename = (lines[0] || "").replace(/^###\s*/, "");
    let fileId = "",
      contentType = "",
      summary = "",
      time = "";
    for (const line of lines.slice(1)) {
      const m = line.match(/^-\s*file_id:\s*`([^`]+)`/);
      if (m) {
        fileId = m[1];
        continue;
      }
      const m2 = line.match(/^-\s*类型:\s*(.+)/);
      if (m2) {
        contentType = m2[1].trim();
        continue;
      }
      const m3 = line.match(/^-\s*摘要:\s*(.+)/);
      if (m3) {
        summary = m3[1].trim();
        continue;
      }
      const m4 = line.match(/^-\s*登记时间:\s*(.+)/);
      if (m4) {
        time = m4[1].trim();
        continue;
      }
    }
    return { filename, fileId, contentType, summary, time };
  });
}

function fileIcon(ct: string): string {
  if (ct.includes("pdf")) return "📄";
  if (ct.includes("word") || ct.includes("doc")) return "📝";
  if (ct.includes("sheet") || ct.includes("excel") || ct.includes("csv"))
    return "📊";
  if (ct.includes("presentation") || ct.includes("ppt")) return "📽️";
  if (ct.includes("image")) return "🖼️";
  if (ct.includes("video")) return "🎬";
  if (ct.includes("audio")) return "🎵";
  return "📎";
}

/* ── RECENT helper: parse page XML into timeline items ─────────────────── */

type TimelineItem = {
  pageId: string;
  from: string;
  to: string;
  summary: string;
};

function parseRecentXml(xml: string): TimelineItem[] {
  if (!xml.trim()) return [];
  const items: TimelineItem[] = [];
  const re =
    /<page\s+id="([^"]*)"[^>]*from="([^"]*)"[^>]*to="([^"]*)">([\s\S]*?)<\/page>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    items.push({ pageId: m[1], from: m[2], to: m[3], summary: m[4] });
  }
  return items;
}

function formatRange(from: string, to: string): string {
  try {
    const a = new Date(from);
    const b = new Date(to);
    const df = a.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
    });
    const tf = a.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const tb = b.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${df} ${tf} — ${tb}`;
  } catch {
    return `${from} — ${to}`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   EntryEditor — 内联 Markdown 编辑器，左写右预览
   ══════════════════════════════════════════════════════════════════════════════ */

function EntryEditor({
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
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题（可选）"
          className="flex-1 text-sm font-medium bg-transparent border-none outline-none placeholder-gray-400"
        />
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          <button
            onClick={() => setPreviewMode(false)}
            className={`text-xs px-2 py-1 rounded ${!previewMode ? "bg-white shadow-sm text-gray-700" : "text-gray-400 hover:text-gray-600"}`}
          >
            编辑
          </button>
          <button
            onClick={() => setPreviewMode(true)}
            className={`text-xs px-2 py-1 rounded ${previewMode ? "bg-white shadow-sm text-gray-700" : "text-gray-400 hover:text-gray-600"}`}
          >
            预览
          </button>
        </div>
      </div>
      {/* Content */}
      <div className="min-h-[160px]">
        {previewMode ? (
          <div className="p-4 prose prose-sm max-w-none text-sm">
            {content.trim() ? (
              <MessageMarkdown text={content} />
            ) : (
              <p className="text-gray-400 italic">暂无内容</p>
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="支持 Markdown 格式…"
            className="w-full min-h-[160px] p-4 text-sm font-mono leading-relaxed resize-y border-none outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                onSave(title, content);
            }}
          />
        )}
      </div>
      {/* Actions */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-t border-gray-100">
        <span className="text-[11px] text-gray-400">Ctrl+Enter 保存</span>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-100"
          >
            取消
          </button>
          <button
            onClick={() => onSave(title, content)}
            disabled={saving || !content.trim()}
            className="text-xs px-3 py-1.5 rounded bg-[#1264A3] text-white hover:bg-[#0f5a94] disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MemoryPage — 全屏记忆页面
   ══════════════════════════════════════════════════════════════════════════════ */

export default function MemoryPage({
  channelId,
  channelName,
  contextData,
  onClose,
}: {
  channelId: string;
  channelName: string;
  contextData: Record<string, string>;
  onClose: () => void;
}) {
  const memoryRole = getStoredRole();
  const canEditMemory = isMemberOrAbove(memoryRole);
  const isMemoryAdmin = isAdminRole(memoryRole);
  const memoryUserId = (() => { try { const s = localStorage.getItem("currentUser"); return s ? JSON.parse(s).user?.user_id : null; } catch { return null; } })();
  const canEditEntry = (entry: MemoryEntryItem) => isMemoryAdmin || entry.created_by === memoryUserId;

  const [activeLayer, setActiveLayer] = useState<string>("ANCHOR");
  const [entries, setEntries] = useState<MemoryEntryItem[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosLoading, setTodosLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [todoNewContent, setTodoNewContent] = useState("");
  const [todoAssignee, setTodoAssignee] = useState("");

  const meta = LAYER_META[activeLayer];

  /* ── Data loaders ─────────────────────────────────────────────────────── */

  const loadEntries = useCallback(
    (layer: string) => {
      setEntriesLoading(true);
      fetch(`${API}/channels/${channelId}/memory/?layer=${layer}`, {
        headers: authHeaders(),
      })
        .then((r) => (r.ok ? r.json() : []))
        .then(setEntries)
        .catch(() => {})
        .finally(() => setEntriesLoading(false));
    },
    [channelId],
  );

  const loadMembers = useCallback(() => {
    setMembersLoading(true);
    fetch(`${API}/channels/${channelId}/members?with_username=1`, {
      headers: authHeaders(),
    })
      .then((r) => r.json())
      .then((d) => setMembers(d.data || []))
      .catch(() => {})
      .finally(() => setMembersLoading(false));
  }, [channelId]);

  const loadTodos = useCallback(() => {
    setTodosLoading(true);
    fetch(`${API}/channels/${channelId}/todos/`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then(setTodos)
      .catch(() => {})
      .finally(() => setTodosLoading(false));
  }, [channelId]);

  const switchLayer = (layer: string) => {
    setActiveLayer(layer);
    setEditingId(null);
    setAddingNew(false);
    if (LAYER_META[layer].entryBased) loadEntries(layer);
    if (layer === "MEMBERS") loadMembers();
    if (layer === "TODO") {
      loadTodos();
      if (!members.length) loadMembers();
    }
  };

  useEffect(() => {
    loadEntries("ANCHOR");
  }, [channelId, loadEntries]);

  /* ── Entry CRUD ───────────────────────────────────────────────────────── */

  const handleCreate = async (title: string, content: string) => {
    setSaving(true);
    const res = await fetch(`${API}/channels/${channelId}/memory/`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        layer: activeLayer,
        title: title || null,
        content,
      }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      setAddingNew(false);
      loadEntries(activeLayer);
    }
  };

  const handleUpdate = async (
    entryId: string,
    title: string,
    content: string,
  ) => {
    setSaving(true);
    const res = await fetch(`${API}/channels/${channelId}/memory/${entryId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ title: title || null, content }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      setEditingId(null);
      loadEntries(activeLayer);
    }
  };

  const handleDelete = async (entryId: string) => {
    const res = await fetch(`${API}/channels/${channelId}/memory/${entryId}`, {
      method: "DELETE",
      headers: authHeaders(),
    }).catch(() => null);
    if (res?.ok) loadEntries(activeLayer);
  };

  /* ── Todo CRUD ────────────────────────────────────────────────────────── */

  const handleTodoCreate = async () => {
    if (!todoNewContent.trim()) return;
    let assignee_id = null,
      assignee_type = null;
    if (todoAssignee) {
      const [t, i] = todoAssignee.split(":");
      assignee_id = i;
      assignee_type = t;
    }
    const res = await fetch(`${API}/channels/${channelId}/todos/`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        content: todoNewContent,
        assignee_id,
        assignee_type,
      }),
    }).catch(() => null);
    if (res?.ok) {
      setTodoNewContent("");
      setTodoAssignee("");
      loadTodos();
    }
  };

  const handleTodoToggle = async (todo: TodoItem) => {
    await fetch(`${API}/channels/${channelId}/todos/${todo.todo_id}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        status: todo.status === "completed" ? "pending" : "completed",
      }),
    }).catch(() => null);
    loadTodos();
  };

  const handleTodoDelete = async (todoId: string) => {
    await fetch(`${API}/channels/${channelId}/todos/${todoId}`, {
      method: "DELETE",
      headers: authHeaders(),
    }).catch(() => null);
    loadTodos();
  };

  const getMemberName = (id: string, type: string) => {
    const m = members.find((x) => x.member_id === id && x.member_type === type);
    return m ? m.display_name || m.username || "Unknown" : null;
  };

  /* ══════════════════════════════════════════════════════════════════════════
     Renderers
     ══════════════════════════════════════════════════════════════════════════ */

  /* ── Entry cards (ANCHOR / DECISIONS / PROGRESS) ──────────────────────── */

  const renderEntryCards = () => {
    if (entriesLoading)
      return (
        <div className="flex items-center justify-center py-20 text-gray-400">
          加载中…
        </div>
      );

    return (
      <div className="space-y-4">
        {entries.map((entry) =>
          editingId === entry.entry_id ? (
            <EntryEditor
              key={entry.entry_id}
              initialTitle={entry.title || ""}
              initialContent={entry.content}
              onSave={(t, c) => handleUpdate(entry.entry_id, t, c)}
              onCancel={() => setEditingId(null)}
              saving={saving}
            />
          ) : (
            <div
              key={entry.entry_id}
              className={`group rounded-lg border ${meta.borderColor} bg-white hover:shadow-md transition-shadow`}
            >
              {/* Card header */}
              <div
                className={`flex items-center justify-between px-4 py-2.5 ${meta.bgLight} rounded-t-lg border-b ${meta.borderColor}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {entry.title ? (
                    <h3 className="text-sm font-semibold text-gray-800 truncate">
                      {entry.title}
                    </h3>
                  ) : (
                    <h3 className="text-sm text-gray-400 italic truncate">
                      无标题
                    </h3>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-[11px] text-gray-400 mr-1">
                    {relativeTime(entry.updated_at)}
                  </span>
                  <button
                    onClick={() => canEditEntry(entry) && setEditingId(entry.entry_id)}
                    disabled={!canEditEntry(entry)}
                    className={`w-7 h-7 flex items-center justify-center rounded-md transition-all ${canEditEntry(entry) ? "text-gray-400 hover:bg-white hover:text-blue-500 hover:shadow-sm" : "text-gray-200 cursor-not-allowed"}`}
                    title={canEditEntry(entry) ? "编辑" : "仅创建者或管理员可编辑"}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={() => canEditEntry(entry) && handleDelete(entry.entry_id)}
                    disabled={!canEditEntry(entry)}
                    className={`w-7 h-7 flex items-center justify-center rounded-md transition-all ${canEditEntry(entry) ? "text-gray-400 hover:bg-white hover:text-red-500 hover:shadow-sm" : "text-gray-200 cursor-not-allowed"}`}
                    title={canEditEntry(entry) ? "删除" : "仅创建者或管理员可删除"}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              {/* Card body — markdown rendered */}
              <div className="px-4 py-3 prose prose-sm max-w-none text-sm leading-relaxed">
                <MessageMarkdown text={entry.content} />
              </div>
              {/* Card footer */}
              {(entry.creator_type || entry.created_at) && (
                <div className="px-4 py-2 border-t border-gray-50 flex items-center gap-2 text-[11px] text-gray-400">
                  {entry.creator_type === "bot" && (
                    <span className="px-1.5 py-0.5 rounded bg-green-50 text-green-600">
                      Bot
                    </span>
                  )}
                  {entry.creator_type === "user" && (
                    <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">
                      用户
                    </span>
                  )}
                  {entry.created_at && (
                    <span>
                      {new Date(entry.created_at).toLocaleString("zh-CN")}
                    </span>
                  )}
                </div>
              )}
            </div>
          ),
        )}

        {/* Add new */}
        {addingNew && (
          <EntryEditor
            initialTitle=""
            initialContent=""
            onSave={handleCreate}
            onCancel={() => setAddingNew(false)}
            saving={saving}
          />
        )}

        {/* Empty state */}
        {entries.length === 0 && !addingNew && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <span className="text-5xl mb-4 opacity-20">{meta.icon}</span>
            <p className="text-gray-500 font-medium mb-1">{meta.desc}</p>
            <p className="text-sm text-gray-400 mb-4">
              暂无记录，点击下方添加第一条
            </p>
            <button
              onClick={() => canEditMemory && setAddingNew(true)}
              disabled={!canEditMemory}
              title={canEditMemory ? "" : "无权限：访客无法添加记录"}
              className={`px-4 py-2 rounded-lg text-sm transition-colors ${canEditMemory ? "bg-[#1264A3] text-white hover:bg-[#0f5a94]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
            >
              + 添加{meta.label}
            </button>
          </div>
        )}
      </div>
    );
  };

  /* ── FILES_INDEX — file card grid ─────────────────────────────────────── */

  const renderFilesIndex = () => {
    const raw = contextData["files_index"] ?? "";
    const cards = parseFilesIndex(raw);
    if (!cards.length) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <span className="text-5xl mb-4 opacity-20">🗂️</span>
          <p className="text-gray-500 font-medium">暂无上传文件</p>
          <p className="text-sm text-gray-400">
            在频道中上传文件后，索引将自动生成
          </p>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((f) => (
          <div
            key={f.fileId || f.filename}
            className="rounded-lg border border-amber-200 bg-white hover:shadow-md transition-shadow overflow-hidden"
          >
            <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border-b border-amber-100">
              <span className="text-2xl flex-shrink-0">
                {fileIcon(f.contentType)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800 truncate">
                  {f.filename}
                </p>
                {f.contentType && (
                  <p className="text-[11px] text-gray-400 truncate">
                    {f.contentType}
                  </p>
                )}
              </div>
            </div>
            {f.summary && (
              <div className="px-4 py-2.5">
                <p className="text-xs text-gray-600 leading-relaxed line-clamp-3">
                  {f.summary}
                </p>
              </div>
            )}
            <div className="px-4 py-2 border-t border-gray-50 flex items-center justify-between">
              <span className="text-[11px] text-gray-400">{f.time}</span>
              <span className="text-[11px] text-gray-300 font-mono">
                {f.fileId.slice(0, 8)}
              </span>
            </div>
          </div>
        ))}
      </div>
    );
  };

  /* ── RECENT — timeline view ───────────────────────────────────────────── */

  const renderRecent = () => {
    const raw = contextData["recent"] ?? "";
    const items = parseRecentXml(raw);
    if (!items.length) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <span className="text-5xl mb-4 opacity-20">🕐</span>
          <p className="text-gray-500 font-medium">暂无历史动态</p>
          <p className="text-sm text-gray-400">对话消息累积后将自动归档</p>
        </div>
      );
    }
    return (
      <div className="relative pl-6">
        {/* Timeline line */}
        <div className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-green-200" />
        <div className="space-y-4">
          {items.map((item, idx) => (
            <div key={item.pageId || idx} className="relative">
              {/* Dot */}
              <div className="absolute -left-6 top-3 w-3 h-3 rounded-full bg-green-400 border-2 border-white shadow-sm" />
              <div className="rounded-lg border border-green-200 bg-white hover:shadow-md transition-shadow overflow-hidden">
                <div className="px-4 py-2.5 bg-green-50 border-b border-green-100 flex items-center gap-2">
                  <span className="text-xs font-medium text-green-700">
                    {formatRange(item.from, item.to)}
                  </span>
                </div>
                <div className="px-4 py-3 text-sm text-gray-700 leading-relaxed">
                  <MessageMarkdown text={item.summary} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  /* ── MEMBERS — member cards ───────────────────────────────────────────── */

  const renderMembers = () => {
    if (membersLoading)
      return (
        <div className="flex items-center justify-center py-20 text-gray-400">
          加载中…
        </div>
      );
    if (!members.length) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <span className="text-5xl mb-4 opacity-20">👥</span>
          <p className="text-gray-500">暂无成员</p>
        </div>
      );
    }
    const sorted = [...members].sort(
      (a, b) =>
        (a.member_type === "bot" ? -1 : 1) - (b.member_type === "bot" ? -1 : 1),
    );
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sorted.map((m) => {
          const isBot = m.member_type === "bot";
          const label =
            m.display_name || m.username || (isBot ? "Bot" : "用户");
          const initial = label.slice(0, 1).toUpperCase();
          return (
            <div
              key={m.member_id}
              className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:shadow-sm transition-shadow"
            >
              <div
                className={`w-10 h-10 ${isBot ? "rounded-lg bg-[#2EB67D]" : "rounded-full bg-[#1264A3]"} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}
              >
                {initial}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800 truncate">
                  {label}
                </p>
                {m.username && m.username !== m.display_name && (
                  <p className="text-xs text-gray-400 truncate">
                    @{m.username}
                  </p>
                )}
              </div>
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full flex-shrink-0 font-medium ${isBot ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-700"}`}
              >
                {isBot ? "Bot" : "用户"}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  /* ── TODO — task board ────────────────────────────────────────────────── */

  const renderTodo = () => {
    const pending = todos.filter((t) => t.status === "pending");
    const completed = todos.filter((t) => t.status === "completed");
    return (
      <div className="space-y-6">
        {/* Create form */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-2">
          <textarea
            rows={2}
            value={todoNewContent}
            onChange={(e) => setTodoNewContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canEditMemory)
                handleTodoCreate();
            }}
            placeholder={canEditMemory ? "新建任务…" : "无权限创建任务"}
            disabled={!canEditMemory}
            className={`w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:border-blue-400 ${!canEditMemory ? "opacity-50 cursor-not-allowed bg-gray-50" : ""}`}
          />
          <div className="flex items-center gap-2">
            <select
              value={todoAssignee}
              onChange={(e) => setTodoAssignee(e.target.value)}
              disabled={!canEditMemory}
              className={`flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-400 text-gray-500 ${!canEditMemory ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <option value="">指派给…</option>
              {members.map((m) => (
                <option
                  key={m.member_id}
                  value={`${m.member_type}:${m.member_id}`}
                >
                  {m.member_type === "bot" ? "🤖 " : "👤 "}
                  {m.display_name || m.username}
                </option>
              ))}
            </select>
            <button
              onClick={handleTodoCreate}
              disabled={!canEditMemory}
              title={canEditMemory ? "" : "无权限：访客无法添加任务"}
              className={`px-4 py-1.5 text-sm rounded-lg flex-shrink-0 ${canEditMemory ? "bg-[#1264A3] text-white hover:bg-[#0f5a94]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
            >
              添加
            </button>
          </div>
        </div>

        {todosLoading ? (
          <div className="text-center py-8 text-gray-400">加载中…</div>
        ) : todos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <span className="text-5xl mb-4 opacity-20">✅</span>
            <p className="text-gray-500">暂无待办</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Pending */}
            {pending.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  未完成 ({pending.length})
                </h3>
                <div className="space-y-2">
                  {pending.map((todo) => (
                    <div
                      key={todo.todo_id}
                      className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:shadow-sm transition-shadow group"
                    >
                      <input
                        type="checkbox"
                        checked={false}
                        onChange={() => canEditMemory && handleTodoToggle(todo)}
                        disabled={!canEditMemory}
                        className={`mt-0.5 w-4 h-4 flex-shrink-0 ${canEditMemory ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-800">{todo.content}</p>
                        {todo.assignee_id && (
                          <p className="text-xs text-gray-400 mt-0.5">
                            →{" "}
                            {getMemberName(
                              todo.assignee_id,
                              todo.assignee_type!,
                            ) ?? todo.assignee_id}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => canEditMemory && handleTodoDelete(todo.todo_id)}
                        disabled={!canEditMemory}
                        className={`flex-shrink-0 ${canEditMemory ? "text-gray-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all" : "text-gray-200 cursor-not-allowed opacity-0 group-hover:opacity-100"}`}
                        title={canEditMemory ? "删除" : "无权限"}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Completed */}
            {completed.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  已完成 ({completed.length})
                </h3>
                <div className="space-y-2">
                  {completed.map((todo) => (
                    <div
                      key={todo.todo_id}
                      className="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50/50 px-4 py-3 group"
                    >
                      <input
                        type="checkbox"
                        checked
                        onChange={() => canEditMemory && handleTodoToggle(todo)}
                        disabled={!canEditMemory}
                        className={`mt-0.5 w-4 h-4 flex-shrink-0 ${canEditMemory ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
                      />
                      <p className="flex-1 text-sm text-gray-400 line-through">
                        {todo.content}
                      </p>
                      <button
                        onClick={() => canEditMemory && handleTodoDelete(todo.todo_id)}
                        disabled={!canEditMemory}
                        className={`flex-shrink-0 ${canEditMemory ? "text-gray-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all" : "text-gray-200 cursor-not-allowed opacity-0 group-hover:opacity-100"}`}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  /* ── Content router ───────────────────────────────────────────────────── */

  const renderContent = () => {
    switch (activeLayer) {
      case "ANCHOR":
      case "DECISIONS":
      case "PROGRESS":
        return renderEntryCards();
      case "FILES_INDEX":
        return renderFilesIndex();
      case "RECENT":
        return renderRecent();
      case "MEMBERS":
        return renderMembers();
      case "TODO":
        return renderTodo();
      default:
        return null;
    }
  };

  /* ══════════════════════════════════════════════════════════════════════════
     Layout
     ══════════════════════════════════════════════════════════════════════════ */

  return (
    <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm flex">
      <div className="flex flex-1 bg-white rounded-lg m-3 shadow-2xl overflow-hidden">
        {/* ── Left sidebar nav ──────────────────────────────────────────── */}
        <nav className="w-56 flex-shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col">
          {/* Header */}
          <div className="px-4 py-4 border-b border-gray-200">
            <h2 className="text-base font-bold text-gray-900">频道记忆</h2>
            {channelName && (
              <p className="text-xs text-gray-400 mt-0.5">#{channelName}</p>
            )}
          </div>
          {/* Layer list */}
          <div className="flex-1 overflow-y-auto py-2">
            {LAYERS.map((layer) => {
              const lm = LAYER_META[layer];
              const active = layer === activeLayer;
              return (
                <button
                  key={layer}
                  onClick={() => switchLayer(layer)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors ${
                    active
                      ? "bg-white border-r-2 border-[#1264A3] shadow-sm"
                      : "hover:bg-gray-100"
                  }`}
                >
                  <span className="text-lg flex-shrink-0">{lm.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-sm font-medium truncate ${active ? "text-[#1264A3]" : "text-gray-700"}`}
                    >
                      {lm.label}
                    </p>
                    <p className="text-[11px] text-gray-400 truncate">
                      {lm.desc}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
          {/* Close button */}
          <div className="p-3 border-t border-gray-200">
            <button
              onClick={onClose}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              关闭
            </button>
          </div>
        </nav>

        {/* ── Main content area ─────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Content header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{meta.icon}</span>
              <div>
                <h2 className="text-lg font-bold text-gray-900">
                  {meta.label}
                </h2>
                <p className="text-xs text-gray-400">{meta.desc}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {meta.entryBased && !addingNew && (
                <button
                  onClick={() => canEditMemory && setAddingNew(true)}
                  disabled={!canEditMemory}
                  title={canEditMemory ? "" : "无权限：访客无法添加记录"}
                  className={`flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg transition-colors ${canEditMemory ? "bg-[#1264A3] text-white hover:bg-[#0f5a94]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  添加
                </button>
              )}
              {meta.entryBased && entries.length > 0 && (
                <span className="text-xs text-gray-400 px-2">
                  {entries.length} 条记录
                </span>
              )}
              {meta.readonly && activeLayer !== "TODO" && (
                <span className="text-xs text-gray-400 px-2 py-1 rounded bg-gray-100">
                  自动生成
                </span>
              )}
              <button
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                title="关闭"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto p-6">{renderContent()}</div>
        </div>
      </div>
    </div>
  );
}
