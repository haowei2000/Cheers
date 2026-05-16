/**
 * MemoryPage — full-screen channel memory page.
 *
 * Features:
 * - Two-column layout with navigation on the left and content on the right.
 * - Structured layers (ANCHOR/DECISIONS/PROGRESS): card entries, Markdown
 *   rendering, and an inline write/preview editor.
 * - FILES_INDEX: file card grid with icon, type, and summary.
 * - RECENT: timeline view.
 * - MEMBERS: member cards.
 * - TODO: task board.
 */
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { AppIcon, FileTypeIcon, type AppIconName } from "./components/icons";
import { MemberRow, sortMembersByKind } from "./components/members";
import type { MemoryEntryItem, MemberItem, TodoItem } from "./types";
import { getAuthToken as getStoredToken } from "./api";

const ico = (name: AppIconName): ReactNode =>
  createElement(AppIcon, { className: "w-full h-full", name });

const API = "/api/v1";

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
    icon: ReactNode;
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
	    icon: ico("note"),
	    color: "text-[var(--accent)]",
	    bgLight: "bg-[var(--accent-muted)]",
	    borderColor: "border-[var(--border)]",
	    entryBased: true,
	  },
	  PROGRESS: {
	    label: "项目进度",
	    desc: "当前进度、已完成、下一步",
	    icon: ico("trending"),
	    color: "text-[var(--green)]",
	    bgLight: "bg-[var(--green-muted)]",
	    borderColor: "border-[var(--border)]",
	    entryBased: true,
	  },
	  DECISIONS: {
	    label: "决策记录",
	    desc: "重要决策及原因",
	    icon: ico("task"),
	    color: "text-[var(--blue)]",
	    bgLight: "bg-[var(--blue-muted)]",
	    borderColor: "border-[var(--border)]",
	    entryBased: true,
	  },
	  FILES_INDEX: {
	    label: "资料索引",
	    desc: "上传的文件与参考资料",
	    icon: ico("archive"),
	    color: "text-[var(--orange)]",
	    bgLight: "bg-[var(--orange-muted)]",
	    borderColor: "border-[var(--border)]",
	    readonly: true,
	  },
	  RECENT: {
	    label: "近期动态",
	    desc: "历史对话摘要",
	    icon: ico("clock"),
	    color: "text-[var(--green)]",
	    bgLight: "bg-[var(--green-muted)]",
	    borderColor: "border-[var(--border)]",
	    readonly: true,
	  },
	  MEMBERS: {
	    label: "频道成员",
	    desc: "用户与 Bot 能力一览",
	    icon: ico("users"),
	    color: "text-[var(--fg-2)]",
	    bgLight: "bg-[var(--surface-soft)]",
	    borderColor: "border-[var(--border)]",
	    readonly: true,
	  },
	  TODO: {
	    label: "待办事项",
	    desc: "频道任务清单",
	    icon: ico("checkCircle"),
	    color: "text-[var(--red)]",
	    bgLight: "bg-[var(--red-muted)]",
	    borderColor: "border-[var(--border)]",
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
    <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-0)] px-3 py-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题（可选）"
          className="an-type-body flex-1 border-none bg-transparent font-medium outline-none placeholder:text-[var(--fg-3)]"
        />
        <div className="an-seg ml-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setPreviewMode(false)}
            className={!previewMode ? "on" : ""}
          >
            编辑
          </button>
          <button
            type="button"
            onClick={() => setPreviewMode(true)}
            className={previewMode ? "on" : ""}
          >
            预览
          </button>
        </div>
      </div>
      {/* Content */}
      <div className="min-h-[160px]">
        {previewMode ? (
          <div className="max-w-none p-4">
            {content.trim() ? (
              <MessageMarkdown text={content} />
            ) : (
              <p className="an-type-meta italic">暂无内容</p>
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="支持 Markdown 格式…"
            className="min-h-[160px] w-full resize-y border-none bg-[var(--bg-1)] p-4 font-mono leading-relaxed text-[var(--fg-1)] outline-none placeholder:text-[var(--fg-3)]"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                onSave(title, content);
            }}
          />
        )}
      </div>
      {/* Actions */}
      <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--bg-0)] px-3 py-2">
        <span className="an-type-caption">Ctrl+Enter 保存</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="an-btn an-btn-sm"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(title, content)}
            disabled={saving || !content.trim()}
            className="an-btn an-btn-primary an-btn-sm"
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
  currentUserId,
  onClose,
}: {
  channelId: string;
  channelName: string;
  contextData: Record<string, string>;
  currentUserId?: string | null;
  onClose: () => void;
}) {
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
	        <div className="an-type-meta flex items-center justify-center py-20">
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
	              className={`group rounded-md border ${meta.borderColor} bg-[var(--bg-1)] transition-colors hover:border-[var(--border-strong)]`}
	            >
	              {/* Card header */}
	              <div
	                className={`flex items-center justify-between border-b ${meta.borderColor} ${meta.bgLight} px-4 py-2.5`}
	              >
	                <div className="flex items-center gap-2 min-w-0">
	                  {entry.title ? (
	                    <h3 className="an-type-body truncate font-semibold">
	                      {entry.title}
	                    </h3>
	                  ) : (
	                    <h3 className="an-type-meta truncate italic">
	                      无标题
	                    </h3>
	                  )}
	                </div>
	                <div className="flex items-center gap-1.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
	                  <span className="an-type-caption mr-1">
	                    {relativeTime(entry.updated_at)}
	                  </span>
	                  <button
	                    type="button"
	                    onClick={() => setEditingId(entry.entry_id)}
	                    className="an-btn an-btn-ghost an-btn-icon"
	                    title="编辑"
	                  >
	                    <AppIcon name="pencil" className="h-3.5 w-3.5" />
	                  </button>
	                  <button
	                    type="button"
	                    onClick={() => handleDelete(entry.entry_id)}
	                    className="an-btn an-btn-ghost an-btn-icon text-[var(--red)]"
	                    title="删除"
	                  >
	                    <AppIcon name="trash" className="h-3.5 w-3.5" />
	                  </button>
	                </div>
	              </div>
	              {/* Card body — markdown rendered */}
	              <div className="max-w-none px-4 py-3 leading-relaxed">
	                <MessageMarkdown text={entry.content} />
	              </div>
	              {/* Card footer */}
	              {(entry.creator_type || entry.created_at) && (
	                <div className="an-type-caption flex items-center gap-2 border-t border-[var(--border)] px-4 py-2">
	                  {entry.creator_type === "bot" && (
	                    <span className="an-chip green">
	                      Bot
	                    </span>
	                  )}
	                  {entry.creator_type === "user" && (
	                    <span className="an-chip accent">
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
	            <span className="block w-12 h-12 mx-auto mb-4 opacity-20">{meta.icon}</span>
	            <p className="an-type-body mb-1 font-medium">{meta.desc}</p>
	            <p className="an-type-meta mb-4">
	              暂无记录，点击下方添加第一条
	            </p>
	            <button
	              type="button"
	              onClick={() => setAddingNew(true)}
	              className="an-btn an-btn-primary"
	            >
	              <AppIcon name="plus" className="h-4 w-4" />
	              添加{meta.label}
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
	          <AppIcon name="archive" className="w-12 h-12 mb-4 opacity-20" />
	          <p className="an-type-body font-medium">暂无上传文件</p>
	          <p className="an-type-meta">
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
	            className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-1)] transition-colors hover:border-[var(--border-strong)]"
	          >
	            <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--orange-muted)] px-4 py-3">
	              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-[var(--bg-1)]">
	                <FileTypeIcon
                  contentType={f.contentType}
                  filename={f.filename}
                  size={30}
                />
              </span>
              <div className="min-w-0 flex-1">
	                <p className="an-type-body truncate font-medium">
	                  {f.filename}
	                </p>
	                {f.contentType && (
	                  <p className="an-type-caption truncate">
	                    {f.contentType}
	                  </p>
                )}
              </div>
            </div>
	            {f.summary && (
	              <div className="px-4 py-2.5">
	                <p className="an-type-meta line-clamp-3 leading-relaxed">
	                  {f.summary}
	                </p>
	              </div>
	            )}
	            <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-2">
	              <span className="an-type-caption">{f.time}</span>
	              <span className="an-type-caption font-mono">
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
	          <AppIcon name="clock" className="w-12 h-12 mb-4 opacity-20" />
	          <p className="an-type-body font-medium">暂无历史动态</p>
	          <p className="an-type-meta">对话消息累积后将自动归档</p>
	        </div>
      );
    }
    return (
      <div className="relative pl-6">
        {/* Timeline line */}
	        <div className="absolute bottom-2 left-[11px] top-2 w-0.5 bg-[var(--green-muted)]" />
        <div className="space-y-4">
          {items.map((item, idx) => (
            <div key={item.pageId || idx} className="relative">
              {/* Dot */}
	              <div className="absolute -left-6 top-3 h-3 w-3 rounded-full border-2 border-[var(--bg-1)] bg-[var(--green)]" />
	              <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-1)] transition-colors hover:border-[var(--border-strong)]">
	                <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--green-muted)] px-4 py-2.5">
	                  <span className="an-type-label text-[var(--green)]">
	                    {formatRange(item.from, item.to)}
	                  </span>
	                </div>
	                <div className="px-4 py-3 leading-relaxed">
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
	        <div className="an-type-meta flex items-center justify-center py-20">
	          加载中…
	        </div>
      );
    if (!members.length) {
      return (
	        <div className="flex flex-col items-center justify-center py-20 text-center">
	          <AppIcon name="users" className="w-12 h-12 mb-4 opacity-20" />
	          <p className="an-type-meta">暂无成员</p>
	        </div>
      );
    }
    const sorted = sortMembersByKind(members, currentUserId);
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sorted.map((m) => (
          <MemberRow key={m.member_id} as="article" member={m} />
        ))}
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
	        <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] p-4">
	          <textarea
            rows={2}
            value={todoNewContent}
            onChange={(e) => setTodoNewContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                handleTodoCreate();
	            }}
	            placeholder="新建任务…"
	            className="an-textarea resize-none"
	          />
	          <div className="flex items-center gap-2">
	            <select
	              value={todoAssignee}
	              onChange={(e) => setTodoAssignee(e.target.value)}
	              className="an-select flex-1"
	            >
	              <option value="">指派给…</option>
	              {members.map((m) => (
                <option
                  key={m.member_id}
	                  value={`${m.member_type}:${m.member_id}`}
	                >
	                  {m.member_type === "bot" ? "Bot · " : "用户 · "}{m.display_name || m.username}
	                </option>
	              ))}
	            </select>
	            <button
	              type="button"
	              onClick={handleTodoCreate}
	              className="an-btn an-btn-primary flex-shrink-0"
	            >
	              添加
            </button>
          </div>
        </div>

        {todosLoading ? (
	          <div className="an-type-meta py-8 text-center">加载中…</div>
	        ) : todos.length === 0 ? (
	          <div className="flex flex-col items-center justify-center py-16 text-center">
	            <AppIcon name="checkCircle" className="w-12 h-12 mb-4 opacity-20" />
	            <p className="an-type-meta">暂无待办</p>
	          </div>
        ) : (
          <div className="space-y-4">
            {/* Pending */}
            {pending.length > 0 && (
              <div>
	                <h3 className="an-type-caption mb-2 font-semibold uppercase">
	                  未完成 ({pending.length})
                </h3>
                <div className="space-y-2">
                  {pending.map((todo) => (
	                    <div
	                      key={todo.todo_id}
	                      className="group flex items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-4 py-3 transition-colors hover:border-[var(--border-strong)]"
	                    >
                      <input
                        type="checkbox"
                        checked={false}
                        onChange={() => handleTodoToggle(todo)}
                        className="mt-0.5 w-4 h-4 cursor-pointer flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
	                        <p className="an-type-body">{todo.content}</p>
	                        {todo.assignee_id && (
	                          <p className="an-type-caption mt-0.5">
	                            →{" "}
                            {getMemberName(
                              todo.assignee_id,
                              todo.assignee_type!,
                            ) ?? todo.assignee_id}
                          </p>
                        )}
                      </div>
	                      <button
	                        type="button"
	                        onClick={() => handleTodoDelete(todo.todo_id)}
	                        className="an-btn an-btn-ghost an-btn-icon flex-shrink-0 text-[var(--red)] opacity-0 transition-opacity group-hover:opacity-100"
	                        title="删除"
	                      >
	                        <AppIcon name="trash" className="h-4 w-4" />
	                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Completed */}
            {completed.length > 0 && (
              <div>
	                <h3 className="an-type-caption mb-2 font-semibold uppercase">
	                  已完成 ({completed.length})
                </h3>
                <div className="space-y-2">
                  {completed.map((todo) => (
	                    <div
	                      key={todo.todo_id}
	                      className="group flex items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-0)] px-4 py-3"
	                    >
                      <input
                        type="checkbox"
                        checked
                        onChange={() => handleTodoToggle(todo)}
                        className="mt-0.5 w-4 h-4 cursor-pointer flex-shrink-0"
                      />
	                      <p className="an-type-meta flex-1 line-through">
	                        {todo.content}
	                      </p>
	                      <button
	                        type="button"
	                        onClick={() => handleTodoDelete(todo.todo_id)}
	                        className="an-btn an-btn-ghost an-btn-icon flex-shrink-0 text-[var(--red)] opacity-0 transition-opacity group-hover:opacity-100"
	                      >
	                        <AppIcon name="trash" className="h-4 w-4" />
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
    <div
      className="an-token-page fixed inset-0 z-[110] flex"
      style={{ background: "var(--overlay)" }}
    >
      <div
        className="flex flex-1 m-3 overflow-hidden"
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 30px 80px var(--shadow)",
        }}
      >
        {/* ── Left layer nav — matches SettingsModal's settings-nav pattern ─ */}
        <nav
          className="an-settings-nav"
          style={{ width: 220, flexShrink: 0, background: "var(--bg-0)" }}
        >
	          <div
	            className="border-b border-[var(--border)] px-3 pb-3 pt-1"
	            style={{ marginBottom: 8 }}
	          >
	            <div className="an-type-title">
	              频道记忆
	            </div>
	            {channelName && (
	              <div className="an-type-caption mt-0.5">
	                #{channelName}
	              </div>
	            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {LAYERS.map((layer) => {
              const lm = LAYER_META[layer];
              const active = layer === activeLayer;
              return (
                <button
                  type="button"
                  key={layer}
                  onClick={() => switchLayer(layer)}
                  className={`an-sn-item ${active ? "on" : ""}`}
                >
                  <span className="an-sn-ico inline-block w-4 h-4">{lm.icon}</span>
                  <div className="min-w-0 flex-1">
	                    <div className="truncate" style={{ color: "inherit" }}>
	                      {lm.label}
	                    </div>
	                    <div className="an-type-caption truncate">
	                      {lm.desc}
	                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="an-sn-sep" />
          <button
            type="button"
            onClick={onClose}
            className="an-btn an-btn-ghost"
            style={{ margin: "0 8px 10px", justifyContent: "center" }}
          >
            关闭
          </button>
        </nav>

        {/* ── Main content area ─────────────────────────────────────────── */}
        <div
          className="flex-1 flex flex-col min-w-0"
          style={{ background: "var(--bg-1)" }}
        >
          {/* Content header */}
          <div
            className="flex items-center justify-between px-6 py-4 flex-shrink-0"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <div className="flex items-center gap-3">
              <span className="inline-block w-6 h-6">{meta.icon}</span>
              <div>
	                <div className="an-type-title">
	                  {meta.label}
	                </div>
	                <div className="an-type-meta">
	                  {meta.desc}
	                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {meta.entryBased && !addingNew && (
                <button
                  type="button"
                  onClick={() => setAddingNew(true)}
                  className="an-btn an-btn-primary an-btn-sm"
                >
                  ＋ 添加
                </button>
              )}
              {meta.entryBased && entries.length > 0 && (
                <span className="an-chip">{entries.length} 条记录</span>
              )}
              {meta.readonly && activeLayer !== "TODO" && (
                <span className="an-chip">自动生成</span>
              )}
	              <button
	                type="button"
	                onClick={onClose}
	                className="an-modal-close"
	                aria-label="关闭"
	                title="关闭"
	              >
	                <AppIcon name="close" className="h-4 w-4" />
	              </button>
            </div>
          </div>
          {/* Scrollable content */}
          <div
            className="flex-1 overflow-y-auto p-6"
            style={{ background: "var(--bg-0)" }}
          >
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
