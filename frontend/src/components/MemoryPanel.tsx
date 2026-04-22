import { useEffect, useState } from "react";
import { MessageMarkdown } from "../MessageMarkdown";
import type { MemberItem, TodoItem, MemoryEntryItem } from "../types";
import { LAYERS } from "../types";
import { LAYER_META } from "../lib/layer-meta";
import { getAuthToken as getStoredToken } from "../api";

const API = "/api/v1";

// ── Memory Panel (right sidebar) ─────────────────────────────────────────────
export function MemoryPanel({
  channelId,
  channelName,
  contextData,
  onClose,
  onExpand,
}: {
  channelId: string;
  channelName: string;
  contextData: Record<string, string>;
  onClose: () => void;
  onExpand: () => void;
}) {
  const [activeLayer, setActiveLayer] = useState<string>("ANCHOR");
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosLoading, setTodosLoading] = useState(false);
  const [todoNewContent, setTodoNewContent] = useState("");
  const [todoAssignee, setTodoAssignee] = useState("");

  // Channel files state (for FILES_INDEX layer)
  const [channelFiles, setChannelFiles] = useState<
    {
      file_id: string;
      original_filename: string;
      content_type: string;
      size_bytes: number;
      status: string;
      summary_3lines: string | null;
      created_at: string | null;
    }[]
  >([]);
  const [channelFilesLoading, setChannelFilesLoading] = useState(false);

  // Entry-based state
  const [entries, setEntries] = useState<MemoryEntryItem[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [addingNew, setAddingNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");

  const meta = LAYER_META[activeLayer];
  const isReadonly = !!meta.readonly;
  const isEntryBased = !!meta.entryBased;
  const rawContent = contextData[activeLayer.toLowerCase()] ?? "";

  const loadEntries = (layer: string) => {
    const token = getStoredToken();
    setEntriesLoading(true);
    fetch(`${API}/channels/${channelId}/memory/?layer=${layer}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.json() : []))
      .then(setEntries)
      .catch(() => {})
      .finally(() => setEntriesLoading(false));
  };

  const loadTodos = () => {
    const token = getStoredToken();
    setTodosLoading(true);
    fetch(`${API}/channels/${channelId}/todos/`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then(setTodos)
      .catch(() => {})
      .finally(() => setTodosLoading(false));
  };

  const switchLayer = (layer: string) => {
    setActiveLayer(layer);
    setEditingEntryId(null);
    setAddingNew(false);
    if (LAYER_META[layer].entryBased) {
      loadEntries(layer);
    }
    if (layer === "MEMBERS") {
      const token = getStoredToken();
      setMembersLoading(true);
      fetch(`${API}/channels/${channelId}/members?with_username=1`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((d) => setMembers(d.data || []))
        .catch(() => {})
        .finally(() => setMembersLoading(false));
    }
    if (layer === "TODO") {
      loadTodos();
      if (members.length === 0) {
        const token = getStoredToken();
        fetch(`${API}/channels/${channelId}/members?with_username=1`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => r.json())
          .then((d) => setMembers(d.data || []))
          .catch(() => {});
      }
    }
    if (layer === "FILES_INDEX") {
      loadChannelFiles();
    }
  };

  const loadChannelFiles = () => {
    const token = getStoredToken();
    setChannelFilesLoading(true);
    fetch(`${API}/files/by-channel/${channelId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.json())
      .then((d) => setChannelFiles(d.data || []))
      .catch(() => {})
      .finally(() => setChannelFilesLoading(false));
  };

  useEffect(() => {
    if (LAYER_META[activeLayer].entryBased) loadEntries(activeLayer);
  }, [channelId]);

  // ── Entry CRUD ──
  const handleCreateEntry = async () => {
    if (!newContent.trim()) return;
    const token = getStoredToken();
    const res = await fetch(`${API}/channels/${channelId}/memory/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        layer: activeLayer,
        title: newTitle || null,
        content: newContent,
      }),
    }).catch(() => null);
    if (res?.ok) {
      setNewTitle("");
      setNewContent("");
      setAddingNew(false);
      loadEntries(activeLayer);
    }
  };

  const handleUpdateEntry = async (entryId: string) => {
    const token = getStoredToken();
    const res = await fetch(`${API}/channels/${channelId}/memory/${entryId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ title: editTitle || null, content: editContent }),
    }).catch(() => null);
    if (res?.ok) {
      setEditingEntryId(null);
      loadEntries(activeLayer);
    }
  };

  const handleDeleteEntry = async (entryId: string) => {
    const token = getStoredToken();
    const res = await fetch(`${API}/channels/${channelId}/memory/${entryId}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => null);
    if (res?.ok) loadEntries(activeLayer);
  };

  const startEditEntry = (entry: MemoryEntryItem) => {
    setEditingEntryId(entry.entry_id);
    setEditTitle(entry.title || "");
    setEditContent(entry.content);
  };

  // ── Todo CRUD ──
  const handleTodoCreate = async () => {
    if (!todoNewContent.trim()) return;
    const token = getStoredToken();
    let assignee_id = null,
      assignee_type = null;
    if (todoAssignee) {
      const [type, id] = todoAssignee.split(":");
      assignee_id = id;
      assignee_type = type;
    }
    const res = await fetch(`${API}/channels/${channelId}/todos/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
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
    const token = getStoredToken();
    const res = await fetch(
      `${API}/channels/${channelId}/todos/${todo.todo_id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          status: todo.status === "completed" ? "pending" : "completed",
        }),
      },
    ).catch(() => null);
    if (res?.ok) loadTodos();
  };

  const handleTodoDelete = async (todoId: string) => {
    const token = getStoredToken();
    const res = await fetch(`${API}/channels/${channelId}/todos/${todoId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (res?.ok) loadTodos();
  };

  const getMemberName = (id: string, type: string) => {
    const m = members.find((x) => x.member_id === id && x.member_type === type);
    return m ? m.display_name || m.username || "Unknown" : null;
  };

  // ── Entry-based layer content renderer ──
  const renderEntryLayer = () => {
    if (entriesLoading) {
      return (
        <div className="flex items-center justify-center h-12 text-gray-400 text-xs">
          加载中…
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-y-auto">
        {/* Entry list */}
        {entries.length === 0 && !addingNew ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 px-4 text-center">
            <span className="text-3xl opacity-30">{meta.icon}</span>
            <p className="text-xs font-medium text-gray-500">暂无内容</p>
            <p className="text-[11px] text-gray-400">{meta.desc}</p>
            <button
              type="button"
              onClick={() => setAddingNew(true)}
              className="mt-1 text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
            >
              添加条目
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {entries.map((entry) =>
              editingEntryId === entry.entry_id ? (
                <li
                  key={entry.entry_id}
                  className="px-3 py-2 space-y-1.5 bg-blue-50/30"
                >
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="标题（可选）"
                    className="w-full text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-blue-400"
                  />
                  <textarea
                    rows={3}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400 font-mono"
                  />
                  <div className="flex gap-1 justify-end">
                    <button
                      onClick={() => setEditingEntryId(null)}
                      className="text-[11px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
                    >
                      取消
                    </button>
                    <button
                      onClick={() => handleUpdateEntry(entry.entry_id)}
                      className="text-[11px] px-2 py-0.5 rounded bg-[#1264A3] text-white hover:bg-[#0f5a94]"
                    >
                      保存
                    </button>
                  </div>
                </li>
              ) : (
                <li
                  key={entry.entry_id}
                  className="px-3 py-2 group hover:bg-gray-50/50"
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <div className="flex-1 min-w-0">
                      {entry.title && (
                        <p className="text-xs font-semibold text-gray-700 mb-0.5">
                          {entry.title}
                        </p>
                      )}
                      <div className="text-xs text-gray-600">
                        <MessageMarkdown text={entry.content} />
                      </div>
                      {entry.updated_at && (
                        <p className="text-[10px] text-gray-300 mt-1">
                          {new Date(entry.updated_at).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => startEditEntry(entry)}
                        className="text-gray-400 hover:text-blue-500 text-[10px] p-0.5"
                        title="编辑"
                      >
                        &#9998;
                      </button>
                      <button
                        onClick={() => handleDeleteEntry(entry.entry_id)}
                        className="text-gray-300 hover:text-red-400 text-[10px] p-0.5"
                        title="删除"
                      >
                        &#10005;
                      </button>
                    </div>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}

        {/* Add new entry form */}
        {addingNew && (
          <div className="px-3 py-2 border-t border-gray-100 space-y-1.5 bg-green-50/20">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="标题（可选）"
              className="w-full text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-blue-400"
            />
            <textarea
              rows={3}
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                  handleCreateEntry();
              }}
              placeholder="内容…"
              className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400 font-mono"
              autoFocus
            />
            <div className="flex gap-1 justify-end">
              <button
                onClick={() => {
                  setAddingNew(false);
                  setNewTitle("");
                  setNewContent("");
                }}
                className="text-[11px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleCreateEntry}
                className="text-[11px] px-2 py-0.5 rounded bg-[#1264A3] text-white hover:bg-[#0f5a94]"
              >
                添加
              </button>
            </div>
          </div>
        )}
      </div>
    );
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
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={onExpand}
            className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-blue-500 text-xs leading-none"
            title="全屏查看"
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
                d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-base leading-none"
            title="关闭"
          >
            ×
          </button>
        </div>
      </div>

      {/* Layer tabs */}
      <div className="flex border-b border-gray-100 flex-shrink-0">
        {LAYERS.map((layer) => {
          const m = LAYER_META[layer];
          const active = layer === activeLayer;
          const filled =
            layer === "TODO"
              ? todos.length > 0
              : m.entryBased
                ? entries.length > 0 && activeLayer === layer
                : !!contextData[layer.toLowerCase()]?.trim();
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
              <span className="leading-none font-medium truncate max-w-full px-0.5">
                {m.label.split(" ")[0]}
              </span>
              {filled && (
                <span className="w-1 h-1 rounded-full bg-current opacity-60" />
              )}
            </button>
          );
        })}
      </div>

      {/* Content toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-gray-700 truncate">
            {meta.label}
          </span>
          {isEntryBased && entries.length > 0 && (
            <span className="text-[10px] text-gray-400 flex-shrink-0">
              {entries.length} 条
            </span>
          )}
          {isReadonly && activeLayer !== "TODO" && (
            <span className="text-[10px] text-gray-400 flex-shrink-0">
              只读
            </span>
          )}
        </div>
        {isEntryBased && !addingNew && entries.length > 0 && (
          <button
            type="button"
            onClick={() => setAddingNew(true)}
            className="text-[11px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
          >
            + 添加
          </button>
        )}
      </div>

      {/* Main content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {activeLayer === "TODO" ? (
          <>
            {/* Todo create form */}
            <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0 space-y-1.5">
              <textarea
                rows={2}
                value={todoNewContent}
                onChange={(e) => setTodoNewContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                    handleTodoCreate();
                }}
                placeholder="新建任务…"
                className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400"
              />
              <div className="flex items-center gap-1.5">
                <select
                  value={todoAssignee}
                  onChange={(e) => setTodoAssignee(e.target.value)}
                  className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:border-blue-400 text-gray-500"
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
                  className="px-2.5 py-1 text-xs bg-[#1264A3] text-white rounded hover:bg-[#0f5a94] flex-shrink-0"
                >
                  添加
                </button>
              </div>
            </div>
            {/* Todo list */}
            <div className="flex-1 overflow-y-auto">
              {todosLoading ? (
                <div className="flex items-center justify-center h-12 text-gray-400 text-xs">
                  加载中…
                </div>
              ) : todos.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-20 text-gray-400 gap-1 text-center px-4">
                  <span className="text-2xl opacity-30">✅</span>
                  <p className="text-xs text-gray-400">暂无待办</p>
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {todos.map((todo) => (
                    <li
                      key={todo.todo_id}
                      className="flex items-start gap-2 px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={todo.status === "completed"}
                        onChange={() => handleTodoToggle(todo)}
                        className="mt-0.5 flex-shrink-0 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-xs ${todo.status === "completed" ? "line-through text-gray-400" : "text-gray-800"}`}
                        >
                          {todo.content}
                        </p>
                        {todo.assignee_id && (
                          <p className="text-[10px] text-gray-400 mt-0.5">
                            →{" "}
                            {getMemberName(
                              todo.assignee_id,
                              todo.assignee_type!,
                            ) ?? todo.assignee_id}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => handleTodoDelete(todo.todo_id)}
                        className="flex-shrink-0 text-gray-300 hover:text-red-400 transition-colors text-[10px] leading-none mt-0.5"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : isEntryBased ? (
          renderEntryLayer()
        ) : activeLayer === "MEMBERS" ? (
          membersLoading ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-xs">
              加载中…
            </div>
          ) : members.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 text-center px-4">
              <span className="text-3xl opacity-30">👥</span>
              <p className="text-xs text-gray-500">暂无成员</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 overflow-y-auto">
              {[...members]
                .sort(
                  (a, b) =>
                    (a.member_type === "bot" ? -1 : 1) -
                    (b.member_type === "bot" ? -1 : 1),
                )
                .map((m) => {
                  const isBot = m.member_type === "bot";
                  const label =
                    m.display_name || m.username || (isBot ? "Bot" : "用户");
                  const sub =
                    m.username && m.username !== m.display_name
                      ? `@${m.username}`
                      : null;
                  const initial = label.slice(0, 1).toUpperCase();
                  return (
                    <div
                      key={m.member_id}
                      className="flex items-center gap-2.5 px-3 py-2"
                    >
                      <div
                        className={`w-7 h-7 rounded${isBot ? "" : "-full"} flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${isBot ? "bg-[#2EB67D]" : "bg-[#1264A3]"}`}
                      >
                        {initial}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-gray-800 truncate">
                          {label}
                        </p>
                        {sub && (
                          <p className="text-[10px] text-gray-400 truncate">
                            {sub}
                          </p>
                        )}
                      </div>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${isBot ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-700"}`}
                      >
                        {isBot ? "Bot" : "用户"}
                      </span>
                    </div>
                  );
                })}
            </div>
          )
        ) : activeLayer === "FILES_INDEX" ? (
          channelFilesLoading ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-xs">
              加载中…
            </div>
          ) : channelFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 px-4 text-center">
              <span className="text-3xl opacity-30">{meta.icon}</span>
              <p className="text-xs font-medium text-gray-500">暂无文件</p>
              <p className="text-[11px] text-gray-400">{meta.desc}</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 overflow-y-auto">
              {channelFiles.map((f) => {
                const ct = f.content_type || "";
                const typeLabel = ct.includes("pdf")
                  ? "PDF"
                  : ct.includes("wordprocessingml") || ct.includes("docx")
                    ? "Word"
                    : ct.includes("spreadsheetml") || ct.includes("xlsx")
                      ? "Excel"
                      : ct.startsWith("text/")
                        ? "文本"
                        : "文件";
                const sizeStr = f.size_bytes
                  ? f.size_bytes < 1024
                    ? `${f.size_bytes} B`
                    : f.size_bytes < 1024 * 1024
                      ? `${(f.size_bytes / 1024).toFixed(1)} KB`
                      : `${(f.size_bytes / (1024 * 1024)).toFixed(1)} MB`
                  : "";
                return (
                  <div
                    key={f.file_id}
                    className="flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50 transition-colors"
                  >
                    <div className="w-8 h-8 rounded-md bg-amber-50 flex items-center justify-center flex-shrink-0">
                      <span className="text-sm">
                        {typeLabel === "PDF"
                          ? "\uD83D\uDCC4"
                          : typeLabel === "Word"
                            ? "\uD83D\uDCC3"
                            : typeLabel === "Excel"
                              ? "\uD83D\uDCCA"
                              : "\uD83D\uDCC1"}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-gray-800 truncate">
                        {f.original_filename || f.file_id}
                      </p>
                      <p className="text-[10px] text-gray-400 truncate">
                        {typeLabel}
                        {sizeStr ? ` · ${sizeStr}` : ""}
                        {f.created_at
                          ? ` · ${f.created_at.slice(0, 10)}`
                          : ""}
                      </p>
                      {f.summary_3lines && (
                        <p className="text-[10px] text-gray-400 truncate mt-0.5">
                          {f.summary_3lines}
                        </p>
                      )}
                    </div>
                    <a
                      href={`${API}/files/${f.file_id}/download`}
                      className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-colors flex-shrink-0"
                      title="下载文件"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="w-4 h-4"
                      >
                        <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                        <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
                      </svg>
                    </a>
                  </div>
                );
              })}
            </div>
          )
        ) : rawContent.trim() ? (
          /* Readonly derived layers (RECENT) */
          <div className="px-3 py-3 text-sm overflow-y-auto">
            <MessageMarkdown text={rawContent} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 px-4 text-center">
            <span className="text-3xl opacity-30">{meta.icon}</span>
            <p className="text-xs font-medium text-gray-500">暂无内容</p>
            <p className="text-[11px] text-gray-400">{meta.desc}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
