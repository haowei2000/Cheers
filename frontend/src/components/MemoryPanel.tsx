import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { MessageMarkdown } from "../MessageMarkdown";
import type { MemberItem, TodoItem, MemoryEntryItem } from "../types";
import { LAYERS } from "../types";
import { LAYER_META } from "../lib/layer-meta";
import { getAuthToken as getStoredToken } from "../api";
import { AppIcon } from "./icons";
import { InviteMemberSearch } from "./InviteMemberSearch";

const API = "/api/v1";

type ChannelFilePreview = {
  file_id: string;
  original_filename?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
};

// ── Memory Panel (right sidebar) ─────────────────────────────────────────────
//
// The panel can be driven in two modes:
//   a) self-contained — no `activeLayer` prop; shows the full layer tab strip.
//   b) controlled     — `activeLayer` + `onLayerChange` supplied; the tab strip
//      is hidden and the parent (channel header cluster) drives which layer is
//      shown. Used for the 4-tab Project/Files/Members/Todos cluster.
//
// Virtual layer "PROJECT" renders the design's Project view: anchor cards at
// the top, an overall progress bar, then a PROGRESS + DECISIONS timeline.
export function MemoryPanel({
  channelId,
  channelName,
  contextData,
  onClose,
  activeLayer: externalLayer,
  onLayerChange,
  currentUserId,
  onFilePreview,
}: {
  channelId: string;
  channelName: string;
  contextData: Record<string, string>;
  onClose: () => void;
  activeLayer?: string;
  onLayerChange?: (layer: string) => void;
  currentUserId?: string | null;
  onFilePreview?: (file: ChannelFilePreview) => void;
}) {
  const isControlled = externalLayer !== undefined;
  const [internalLayer, setInternalLayer] = useState<string>("ANCHOR");
  const activeLayer = isControlled ? (externalLayer as string) : internalLayer;
  const setActiveLayer = (l: string) => {
    if (isControlled) onLayerChange?.(l);
    else setInternalLayer(l);
  };

  const [members, setMembers] = useState<MemberItem[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberPermissions, setMemberPermissions] = useState({
    can_invite_members: false,
    can_add_bots: false,
  });
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosLoading, setTodosLoading] = useState(false);
  const [todoNewContent, setTodoNewContent] = useState("");
  const [todoAssignee, setTodoAssignee] = useState("");

  // Secondary entry lists for the PROJECT virtual layer (anchors + decisions)
  const [projectAnchors, setProjectAnchors] = useState<MemoryEntryItem[]>([]);
  const [projectDecisions, setProjectDecisions] = useState<MemoryEntryItem[]>(
    [],
  );

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
  const [timelineMode, setTimelineMode] = useState(false);
  const [projectEditing, setProjectEditing] = useState(false);
  const [projectEditLayer, setProjectEditLayer] = useState<
    "ANCHOR" | "PROGRESS" | "DECISIONS"
  >("ANCHOR");

  const [profileNickname, setProfileNickname] = useState("");
  const [profileBio, setProfileBio] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);

  const isProject = activeLayer === "PROJECT";
  const PROJECT_META = {
    label: "项目 · Project",
    desc: "核心目标与进度（Anchor + Progress）",
    color: "blue",
    icon: "◆",
    readonly: false,
    entryBased: false,
  };
  const meta = isProject ? PROJECT_META : LAYER_META[activeLayer];
  const isReadonly = !!meta.readonly;
  const isEntryBased = !!meta.entryBased;
  const canInviteFromMembers =
    activeLayer === "MEMBERS" &&
    (memberPermissions.can_invite_members || memberPermissions.can_add_bots);
  const rawContent = isProject
    ? ""
    : contextData[activeLayer.toLowerCase()] ?? "";

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

  // Project view needs ANCHOR (for goal cards), PROGRESS (for timeline +
  // progress bar), and DECISIONS (also on the timeline).
  const loadProject = () => {
    const token = getStoredToken();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    setEntriesLoading(true);
    Promise.all([
      fetch(`${API}/channels/${channelId}/memory/?layer=ANCHOR`, {
        headers,
      }).then((r) => (r.ok ? r.json() : [])),
      fetch(`${API}/channels/${channelId}/memory/?layer=PROGRESS`, {
        headers,
      }).then((r) => (r.ok ? r.json() : [])),
      fetch(`${API}/channels/${channelId}/memory/?layer=DECISIONS`, {
        headers,
      }).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([anchors, progress, decisions]: MemoryEntryItem[][]) => {
        setProjectAnchors(anchors || []);
        setEntries(progress || []);
        setProjectDecisions(decisions || []);
      })
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

  const loadMembers = () => {
    const token = getStoredToken();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    setMembersLoading(true);
    fetch(`${API}/channels/${channelId}/settings`, { headers })
      .then((r) => r.json())
      .then((d) => {
        setMembers(d.data?.members || []);
        setMemberPermissions({
          can_invite_members: Boolean(d.data?.permissions?.can_invite_members),
          can_add_bots: Boolean(d.data?.permissions?.can_add_bots),
        });
      })
      .catch(() => {
        setMembers([]);
        setMemberPermissions({ can_invite_members: false, can_add_bots: false });
      })
      .finally(() => setMembersLoading(false));
  };

  const loadMyProfile = () => {
    const token = getStoredToken();
    setProfileLoading(true);
    fetch(`${API}/channels/${channelId}/my-profile`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.json())
      .then((d) => {
        setProfileNickname(d.data?.nickname || "");
        setProfileBio(d.data?.bio || "");
      })
      .catch(() => {})
      .finally(() => setProfileLoading(false));
  };
  const switchLayer = (layer: string) => {
    setActiveLayer(layer);
    setEditingEntryId(null);
    setAddingNew(false);
    if (layer === "PROJECT") {
      loadProject();
      return;
    }
    if (LAYER_META[layer]?.entryBased) {
      loadEntries(layer);
    }
    if (layer === "MEMBERS") {
      loadMembers();
      loadMyProfile();
    }
    if (layer === "TODO") {
      loadTodos();
      if (members.length === 0) {
        loadMembers();
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
    if (activeLayer === "PROJECT") loadProject();
    else if (LAYER_META[activeLayer]?.entryBased) loadEntries(activeLayer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // When the parent-controlled layer changes, refetch data for it.
  useEffect(() => {
    if (!isControlled) return;
    switchLayer(activeLayer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalLayer]);

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

  const handleProjectCreateEntry = async () => {
    if (!newContent.trim()) return;
    const token = getStoredToken();
    const res = await fetch(`${API}/channels/${channelId}/memory/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        layer: projectEditLayer,
        title: newTitle || null,
        content: newContent,
      }),
    }).catch(() => null);
    if (res?.ok) {
      setNewTitle("");
      setNewContent("");
      setAddingNew(false);
      loadProject();
    }
  };

  const handleProjectUpdateEntry = async (entryId: string) => {
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
      loadProject();
    }
  };

  const handleProjectDeleteEntry = async (entryId: string) => {
    const token = getStoredToken();
    const res = await fetch(`${API}/channels/${channelId}/memory/${entryId}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => null);
    if (res?.ok) loadProject();
  };

  const saveMyProfile = async () => {
    const token = getStoredToken();
    setProfileSaving(true);
    try {
      const res = await fetch(`${API}/channels/${channelId}/my-profile`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          nickname: profileNickname || null,
          bio: profileBio || null,
        }),
      });
      if (!res.ok) throw new Error();
      toast.success("频道资料已更新");
    } catch {
      toast.error("保存频道资料失败");
    } finally {
      setProfileSaving(false);
    }
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
            <span className="block w-8 h-8 opacity-30">{meta.icon}</span>
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
        ) : timelineMode && (activeLayer === "PROGRESS" || activeLayer === "DECISIONS") ? (
          <div className="px-3 py-3">
            <div className="an-tl-title">
              {activeLayer === "DECISIONS" ? "Decisions" : "Progress"} · Timeline
            </div>
            <div className="an-timeline">
              {entries.map((entry) => {
                const isDone = /done|完成|已做|shipped|merged|resolved|批准|approved/i.test(
                  entry.content + " " + (entry.title || ""),
                );
                const kind =
                  activeLayer === "DECISIONS"
                    ? "decision"
                    : isDone
                      ? "done"
                      : "progress";
                return (
                  <div key={entry.entry_id} className={`an-tl-item ${kind}`}>
                    <div className="an-tl-dot" />
                    <div className="an-tl-kind">
                      {activeLayer === "DECISIONS"
                        ? "Decision"
                        : isDone
                          ? "Done"
                          : "Progress"}
                    </div>
                    {entry.title && (
                      <div
                        className="an-tl-tx"
                        style={{ fontWeight: 600, marginBottom: 2 }}
                      >
                        {entry.title}
                      </div>
                    )}
                    <div className="an-tl-tx">
                      <MessageMarkdown text={entry.content} />
                    </div>
                    {entry.updated_at && (
                      <div className="an-tl-mt">
                        {new Date(entry.updated_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="px-3 py-2">
            {entries.map((entry) => {
              if (editingEntryId === entry.entry_id) {
                return (
                  <div
                    key={entry.entry_id}
                    className="px-1 py-2 space-y-1.5"
                    style={{
                      background: "var(--accent-muted)",
                      borderRadius: 6,
                      marginBottom: 4,
                    }}
                  >
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      placeholder="标题（可选）"
                      className="w-full text-xs rounded px-2 py-1 focus:outline-none"
                      style={{
                        background: "var(--bg-0)",
                        border: "1px solid var(--border)",
                        color: "var(--fg-1)",
                      }}
                    />
                    <textarea
                      rows={3}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="w-full text-xs rounded px-2 py-1.5 resize-none focus:outline-none font-mono"
                      style={{
                        background: "var(--bg-0)",
                        border: "1px solid var(--border)",
                        color: "var(--fg-1)",
                      }}
                    />
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => setEditingEntryId(null)}
                        className="text-[11px] px-2 py-0.5 rounded"
                        style={{
                          border: "1px solid var(--border)",
                          color: "var(--fg-2)",
                          background: "transparent",
                        }}
                      >
                        取消
                      </button>
                      <button
                        onClick={() => handleUpdateEntry(entry.entry_id)}
                        className="text-[11px] px-2 py-0.5 rounded"
                        style={{
                          background: "var(--accent)",
                          color: "#fff",
                          border: 0,
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                );
              }
              const isDone = /done|完成|已做|shipped|merged|resolved|批准|approved/i.test(
                entry.content + " " + (entry.title || ""),
              );
              const cls =
                activeLayer === "ANCHOR"
                  ? "anchor"
                  : isDone
                    ? "done"
                    : "";
              return (
                <div key={entry.entry_id} className={`an-mem-item ${cls} group`}>
                  <div className="an-tick" />
                  <div className="an-b">
                    {entry.title && (
                      <div
                        className="an-tx"
                        style={{ fontWeight: 600, marginBottom: 2 }}
                      >
                        {entry.title}
                      </div>
                    )}
                    <div className="an-tx">
                      <MessageMarkdown text={entry.content} />
                    </div>
                    {entry.updated_at && (
                      <div className="an-mt">
                        {new Date(entry.updated_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity self-start">
                    <button
                      onClick={() => startEditEntry(entry)}
                      className="text-[11px] p-1 rounded hover:bg-[var(--surface-soft)]"
                      style={{ color: "var(--fg-3)" }}
                      title="编辑"
                    >
                      &#9998;
                    </button>
                    <button
                      onClick={() => handleDeleteEntry(entry.entry_id)}
                      className="text-[11px] p-1 rounded hover:bg-[var(--surface-soft)]"
                      style={{ color: "var(--fg-3)" }}
                      title="删除"
                    >
                      &#10005;
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
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

  const renderProjectEditor = () => {
    const projectEntries =
      projectEditLayer === "ANCHOR"
        ? projectAnchors
        : projectEditLayer === "PROGRESS"
          ? entries
          : projectDecisions;
    const labels: Record<typeof projectEditLayer, string> = {
      ANCHOR: "Anchor",
      PROGRESS: "Progress",
      DECISIONS: "Decisions",
    };

    if (entriesLoading) {
      return (
        <div className="flex items-center justify-center h-12 text-gray-400 text-xs">
          加载中…
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-2 border-b border-gray-100">
          <div className="an-seg w-full" style={{ height: 28 }}>
            {(["ANCHOR", "PROGRESS", "DECISIONS"] as const).map((layer) => (
              <button
                key={layer}
                type="button"
                className={projectEditLayer === layer ? "on" : ""}
                onClick={() => {
                  setProjectEditLayer(layer);
                  setEditingEntryId(null);
                  setAddingNew(false);
                  setNewTitle("");
                  setNewContent("");
                }}
              >
                {labels[layer]}
              </button>
            ))}
          </div>
        </div>

        {projectEntries.length === 0 && !addingNew ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-400 gap-2 px-4 text-center">
            <p className="text-xs font-medium text-gray-500">
              暂无 {labels[projectEditLayer]} 内容
            </p>
            <button
              type="button"
              onClick={() => setAddingNew(true)}
              className="mt-1 text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
            >
              添加条目
            </button>
          </div>
        ) : (
          <div className="px-3 py-2">
            {projectEntries.map((entry) => {
              if (editingEntryId === entry.entry_id) {
                return (
                  <div
                    key={entry.entry_id}
                    className="px-1 py-2 space-y-1.5"
                    style={{
                      background: "var(--accent-muted)",
                      borderRadius: 6,
                      marginBottom: 4,
                    }}
                  >
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      placeholder="标题（可选）"
                      className="w-full text-xs rounded px-2 py-1 focus:outline-none"
                      style={{
                        background: "var(--bg-0)",
                        border: "1px solid var(--border)",
                        color: "var(--fg-1)",
                      }}
                    />
                    <textarea
                      rows={3}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="w-full text-xs rounded px-2 py-1.5 resize-none focus:outline-none font-mono"
                      style={{
                        background: "var(--bg-0)",
                        border: "1px solid var(--border)",
                        color: "var(--fg-1)",
                      }}
                    />
                    <div className="flex gap-1 justify-end">
                      <button
                        type="button"
                        onClick={() => setEditingEntryId(null)}
                        className="text-[11px] px-2 py-0.5 rounded"
                        style={{
                          border: "1px solid var(--border)",
                          color: "var(--fg-2)",
                          background: "transparent",
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={() => handleProjectUpdateEntry(entry.entry_id)}
                        className="text-[11px] px-2 py-0.5 rounded"
                        style={{
                          background: "var(--accent)",
                          color: "#fff",
                          border: 0,
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div key={entry.entry_id} className="an-mem-item anchor group">
                  <div className="an-tick" />
                  <div className="an-b">
                    {entry.title && (
                      <div
                        className="an-tx"
                        style={{ fontWeight: 600, marginBottom: 2 }}
                      >
                        {entry.title}
                      </div>
                    )}
                    <div className="an-tx">
                      <MessageMarkdown text={entry.content} />
                    </div>
                    {entry.updated_at && (
                      <div className="an-mt">
                        {new Date(entry.updated_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity self-start">
                    <button
                      type="button"
                      onClick={() => startEditEntry(entry)}
                      className="text-[11px] p-1 rounded hover:bg-[var(--surface-soft)]"
                      style={{ color: "var(--fg-3)" }}
                      title="编辑"
                    >
                      &#9998;
                    </button>
                    <button
                      type="button"
                      onClick={() => handleProjectDeleteEntry(entry.entry_id)}
                      className="text-[11px] p-1 rounded hover:bg-[var(--surface-soft)]"
                      style={{ color: "var(--fg-3)" }}
                      title="删除"
                    >
                      &#10005;
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

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
                  handleProjectCreateEntry();
              }}
              placeholder="内容…"
              className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400 font-mono"
              autoFocus
            />
            <div className="flex gap-1 justify-end">
              <button
                type="button"
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
                type="button"
                onClick={handleProjectCreateEntry}
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

  const renderMembersHub = () => {
    return (
      <div className="flex-1 overflow-y-auto">
        {canInviteFromMembers && (
          <div className="px-3 py-3 border-b border-gray-100">
            <div className="rounded-md border border-gray-200 p-2.5">
              <div className="text-xs font-semibold text-gray-700 mb-2">
                邀请成员
              </div>
              <InviteMemberSearch
                channelId={channelId}
                members={members}
                canInviteMembers={memberPermissions.can_invite_members}
                canAddBots={memberPermissions.can_add_bots}
                onInvited={loadMembers}
              />
            </div>
          </div>
        )}

        {membersLoading ? (
          <div className="flex items-center justify-center h-20 text-gray-400 text-xs">
            加载中…
          </div>
        ) : members.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 text-gray-400 gap-2 text-center px-4">
            <AppIcon name="users" className="w-8 h-8 opacity-30" />
            <p className="text-xs text-gray-500">暂无成员</p>
          </div>
        ) : (
          <MembersView
            members={members}
            currentUserId={currentUserId}
            profileLoading={profileLoading}
            profileNickname={profileNickname}
            profileBio={profileBio}
            profileSaving={profileSaving}
            onProfileNicknameChange={setProfileNickname}
            onProfileBioChange={setProfileBio}
            onSaveMyProfile={saveMyProfile}
          />
        )}
      </div>
    );
  };

  return (
    <aside className="an-memory w-full flex flex-col" style={{ minHeight: 0 }}>
      {/* Panel header */}
      <div className="an-memory-head flex-shrink-0">
        <div className="min-w-0">
          <div className="an-t">频道记忆</div>
          {channelName && <div className="an-sub">#{channelName}</div>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--surface-soft)] transition-colors"
            style={{ color: "var(--fg-3)", fontSize: 16, lineHeight: 1 }}
            title="关闭"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Layer tabs (self-contained mode only; cluster lives in the channel
         header when controlled by the parent). */}
      {!isControlled && (
        <div className="an-memory-tabs flex-shrink-0">
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
                className={`an-tab ${active ? "on" : ""}`}
              >
                {m.label.split(" ")[0]}
                {filled && (
                  <span
                    className="inline-block w-1 h-1 rounded-full ml-1"
                    style={{
                      background: active ? "var(--accent)" : "var(--fg-3)",
                      verticalAlign: "middle",
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Content toolbar */}
      <div
        className="flex items-center justify-between px-3 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="text-xs font-semibold truncate"
            style={{ color: "var(--fg-2)" }}
          >
            {meta.label}
          </span>
          {isEntryBased && entries.length > 0 && (
            <span
              className="text-[10px] flex-shrink-0"
              style={{ color: "var(--fg-3)" }}
            >
              {entries.length} 条
            </span>
          )}
          {isReadonly && activeLayer !== "TODO" && !canInviteFromMembers && (
            <span
              className="text-[10px] flex-shrink-0"
              style={{ color: "var(--fg-3)" }}
            >
              只读
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isProject && (
            <button
              type="button"
              onClick={() => {
                setProjectEditing((v) => !v);
                setEditingEntryId(null);
                setAddingNew(false);
              }}
              className="text-[11px] px-2 py-1 rounded"
              style={{
                border: "1px solid var(--border)",
                color: projectEditing ? "var(--accent)" : "var(--fg-2)",
                background: projectEditing ? "var(--accent-muted)" : "transparent",
              }}
            >
              {projectEditing ? "完成" : "编辑"}
            </button>
          )}
          {isProject && projectEditing && !addingNew && (
            <button
              type="button"
              onClick={() => setAddingNew(true)}
              className="text-[11px] px-2 py-1 rounded"
              style={{
                border: "1px solid var(--border)",
                color: "var(--fg-2)",
                background: "transparent",
              }}
            >
              + 添加
            </button>
          )}
          {isEntryBased &&
            (activeLayer === "PROGRESS" || activeLayer === "DECISIONS") &&
            entries.length > 0 && (
              <div
                className="an-seg"
                style={{ height: 24 }}
                role="group"
                aria-label="视图切换"
              >
                <button
                  type="button"
                  className={!timelineMode ? "on" : ""}
                  onClick={() => setTimelineMode(false)}
                  title="列表视图"
                >
                  列表
                </button>
                <button
                  type="button"
                  className={timelineMode ? "on" : ""}
                  onClick={() => setTimelineMode(true)}
                  title="时间线视图"
                >
                  时间线
                </button>
              </div>
            )}
          {isEntryBased && !addingNew && entries.length > 0 && (
            <button
              type="button"
              onClick={() => setAddingNew(true)}
              className="text-[11px] px-2 py-1 rounded"
              style={{
                border: "1px solid var(--border)",
                color: "var(--fg-2)",
                background: "transparent",
              }}
            >
              + 添加
            </button>
          )}
        </div>
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
                  <AppIcon name="checkCircle" className="w-6 h-6 opacity-30" />
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
        ) : isProject ? (
          projectEditing ? (
            renderProjectEditor()
          ) : (
            <ProjectView
              anchors={projectAnchors}
              progress={entries}
              decisions={projectDecisions}
              loading={entriesLoading}
            />
          )
        ) : isEntryBased ? (
          renderEntryLayer()
        ) : activeLayer === "MEMBERS" ? (
          renderMembersHub()
        ) : activeLayer === "FILES_INDEX" ? (
          channelFilesLoading ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-xs">
              加载中…
            </div>
          ) : channelFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 px-4 text-center">
              <span className="block w-8 h-8 opacity-30">{meta.icon}</span>
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
                    role={onFilePreview ? "button" : undefined}
                    tabIndex={onFilePreview ? 0 : undefined}
                    onClick={() => onFilePreview?.(f)}
                    onKeyDown={(event) => {
                      if (!onFilePreview) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onFilePreview(f);
                      }
                    }}
                    className={`flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50 transition-colors ${
                      onFilePreview ? "cursor-pointer" : ""
                    }`}
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
                      onClick={(event) => event.stopPropagation()}
                      className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-colors flex-shrink-0"
                      title="下载文件"
                    >
                      <AppIcon name="download" className="w-4 h-4" />
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
            <span className="block w-8 h-8 opacity-30">{meta.icon}</span>
            <p className="text-xs font-medium text-gray-500">暂无内容</p>
            <p className="text-[11px] text-gray-400">{meta.desc}</p>
          </div>
        )}
      </div>

      {/* Quick-add footer — matches the design's .mem-foot. Shown only for
          writable entry-based layers. Enter posts, Esc clears. */}
      {isEntryBased && !isReadonly && !isProject && (
        <QuickAddFooter
          channelId={channelId}
          layer={activeLayer}
          onAdded={() => loadEntries(activeLayer)}
        />
      )}
    </aside>
  );
}

function QuickAddFooter({
  channelId,
  layer,
  onAdded,
}: {
  channelId: string;
  layer: string;
  onAdded: () => void;
}) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const text = v.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const token = getStoredToken();
      const res = await fetch(`${API}/channels/${channelId}/memory/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ layer, title: null, content: text }),
      });
      if (res.ok) {
        setV("");
        onAdded();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex items-center gap-2 flex-shrink-0"
      style={{
        padding: "10px 14px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-1)",
      }}
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            setV("");
          }
        }}
        placeholder="教一下 agents…"
        disabled={busy}
        className="an-input"
        style={{
          flex: 1,
          fontSize: 12,
          padding: "0 10px",
          height: 28,
          lineHeight: "28px",
        }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!v.trim() || busy}
        className="an-btn an-btn-sm"
        title="保存为一条新条目（Enter 亦可）"
        style={{ height: 28, padding: "0 12px", flexShrink: 0 }}
      >
        {busy ? "…" : "保存"}
      </button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Members view — a list of bots + people. Clicking a row opens a profile card
// with back navigation, status, and quick actions.
// ═════════════════════════════════════════════════════════════════════════════

const MEM_COLORS = [
  "#7c6cf5",
  "#3ecf8e",
  "#56a7ff",
  "#f5a623",
  "#f05454",
  "#9586ff",
  "#5b8dff",
];

function colorForMember(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return MEM_COLORS[Math.abs(h) % MEM_COLORS.length];
}

function initialsFor(label: string): string {
  const parts = label.trim().split(/\s+/);
  const first = parts[0]?.[0] || "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + second).toUpperCase() || label.slice(0, 1).toUpperCase();
}

function MembersView({
  members,
  currentUserId,
  profileLoading,
  profileNickname,
  profileBio,
  profileSaving,
  onProfileNicknameChange,
  onProfileBioChange,
  onSaveMyProfile,
}: {
  members: MemberItem[];
  currentUserId?: string | null;
  profileLoading: boolean;
  profileNickname: string;
  profileBio: string;
  profileSaving: boolean;
  onProfileNicknameChange: (value: string) => void;
  onProfileBioChange: (value: string) => void;
  onSaveMyProfile: () => void;
}) {
  const [selected, setSelected] = useState<MemberItem | null>(null);

  const bots = members.filter((m) => m.member_type === "bot");
  const users = members
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => member.member_type !== "bot")
    .sort((a, b) => {
      const aSelf = Boolean(currentUserId && a.member.member_id === currentUserId);
      const bSelf = Boolean(currentUserId && b.member.member_id === currentUserId);
      if (aSelf !== bSelf) return aSelf ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ member }) => member);

  if (selected) {
    const isBot = selected.member_type === "bot";
    const isSelf = Boolean(currentUserId && selected.member_id === currentUserId && !isBot);
    const label =
      selected.display_name ||
      selected.username ||
      (isBot ? "Bot" : "用户");
    const color = colorForMember(selected.member_id);
    return (
      <div className="overflow-y-auto px-3 py-2">
        <div className="an-mem-detail">
          <button
            type="button"
            className="an-md-back"
            onClick={() => setSelected(null)}
          >
            ← 返回成员列表
          </button>
          <div className="an-md-head">
            <div
              className="an-av"
              style={{ background: color, borderRadius: isBot ? 9 : 999 }}
            >
              {initialsFor(label)}
            </div>
            <div className="an-info">
              <div className="an-n">
                {label}
                <span
                  className={
                    "an-tag-pill" + (isBot ? "" : "")
                  }
                  style={{
                    fontSize: 8.5,
                    fontWeight: 700,
                    letterSpacing: "0.7px",
                    padding: "1px 5px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    textTransform: "uppercase",
                    color: isBot ? "var(--fg-3)" : "var(--accent)",
                    background: isBot
                      ? "var(--surface-soft)"
                      : "var(--accent-muted)",
                  }}
                >
                  {isBot ? "BOT" : "USER"}
                </span>
              </div>
              <div className="an-h">
                {selected.username && (
                  <span className="an-d">@{selected.username}</span>
                )}
                {selected.username && (
                  <span className="an-dot-sep">·</span>
                )}
                <span>{isBot ? "channel agent" : "channel member"}</span>
              </div>
            </div>
          </div>

          {isSelf ? (
            <div className="an-md-section">
              <div className="an-lbl">我的频道资料</div>
              {profileLoading ? (
                <div className="text-xs text-gray-400 py-3">加载中…</div>
              ) : (
                <div className="space-y-2">
                  <input
                    value={profileNickname}
                    onChange={(e) => onProfileNicknameChange(e.target.value)}
                    placeholder="频道昵称"
                    maxLength={64}
                    className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
                  />
                  <textarea
                    value={profileBio}
                    onChange={(e) => onProfileBioChange(e.target.value)}
                    placeholder="在本频道的身份介绍…"
                    rows={3}
                    className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={onSaveMyProfile}
                      disabled={profileSaving}
                      className="text-[11px] px-2.5 py-1 rounded bg-[#1264A3] text-white hover:bg-[#0f5a94] disabled:opacity-50"
                    >
                      {profileSaving ? "保存中…" : "保存资料"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="an-md-section">
              <div className="an-lbl">简介 · About</div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--fg-2)",
                  lineHeight: 1.5,
                }}
              >
                {isBot
                  ? "本频道的智能体，协同其他成员完成任务。"
                  : "本频道的用户成员。"}
              </div>
            </div>
          )}

          <div className="an-md-section">
            <div className="an-lbl">资料 · Profile</div>
            <div className="an-md-kv">
              <div className="an-k">ID</div>
              <div className="an-v" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                {selected.member_id}
              </div>
              <div className="an-k">类型</div>
              <div className="an-v">{isBot ? "Bot 智能体" : "人类成员"}</div>
              {selected.username && (
                <>
                  <div className="an-k">用户名</div>
                  <div className="an-v">@{selected.username}</div>
                </>
              )}
              {selected.display_name && (
                <>
                  <div className="an-k">显示名</div>
                  <div className="an-v">{selected.display_name}</div>
                </>
              )}
            </div>
          </div>

          <div className="an-md-actions">
            <button type="button">私聊</button>
            <button type="button">{isBot ? "查看日志" : "资料卡"}</button>
            <button type="button" className="primary">
              @ 提及
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="an-members-list min-h-0 flex-1 overflow-y-auto">
      {bots.length > 0 && (
        <>
          <div className="an-mem-group">
            <span>Agents · 智能体</span>
            <span className="an-ct">{bots.length}</span>
          </div>
          {bots.map((m) => {
            const label = m.display_name || m.username || "Bot";
            const color = colorForMember(m.member_id);
            return (
              <button
                key={m.member_id}
                type="button"
                className="an-mem-row"
                onClick={() => setSelected(m)}
              >
                <div className="an-av-wrap">
                  <div
                    className="an-av bot"
                    style={{ background: color }}
                  >
                    {initialsFor(label)}
                  </div>
                </div>
                <div className="an-r-main">
                  <div className="an-r-name">
                    {label}
                    <span className="an-tag-pill">Bot</span>
                  </div>
                  {m.username && m.username !== label && (
                    <div className="an-r-sub">@{m.username}</div>
                  )}
                </div>
                <span className="an-chev" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </>
      )}
      {users.length > 0 && (
        <>
          <div className="an-mem-group">
            <span>People · 成员</span>
            <span className="an-ct">{users.length}</span>
          </div>
          {users.map((m) => {
            const label = m.display_name || m.username || "用户";
            const color = colorForMember(m.member_id);
            const isSelf = Boolean(currentUserId && m.member_id === currentUserId);
            return (
              <button
                key={m.member_id}
                type="button"
                className={`an-mem-row ${isSelf ? "self" : ""}`}
                onClick={() => setSelected(m)}
                title={isSelf ? "我的频道资料" : undefined}
                aria-label={isSelf ? "我的频道资料" : label}
              >
                <div className="an-av-wrap">
                  {m.avatar_url ? (
                    <img
                      src={m.avatar_url}
                      alt={label}
                      className="an-av"
                      style={{ borderRadius: 999 }}
                    />
                  ) : (
                    <div
                      className="an-av"
                      style={{ background: color, borderRadius: 999 }}
                    >
                      {initialsFor(label)}
                    </div>
                  )}
                  {isSelf && (
                    <span className="an-self-edit" aria-hidden="true">
                      <AppIcon name="pencil" />
                    </span>
                  )}
                </div>
                <div className="an-r-main">
                  <div className="an-r-name">
                    {label}
                    {isSelf && <span className="an-tag-pill self">我</span>}
                  </div>
                  {m.username && m.username !== label && (
                    <div className="an-r-sub">@{m.username}</div>
                  )}
                </div>
                <span className="an-chev" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </>
      )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Project view — design's PROJECT tab rendered as a journey diagram.
// Anchor node with progress ring, legend, a vertical river of decision /
// progress nodes (chronological), and a dashed end-node with the goal state.
// ═════════════════════════════════════════════════════════════════════════════

function ProjectView({
  anchors,
  progress,
  decisions,
  loading,
}: {
  anchors: MemoryEntryItem[];
  progress: MemoryEntryItem[];
  decisions: MemoryEntryItem[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div
        className="flex items-center justify-center h-20 text-xs"
        style={{ color: "var(--fg-3)" }}
      >
        加载中…
      </div>
    );
  }

  const doneRe = /done|完成|已做|shipped|merged|resolved|批准|approved/i;
  const isDone = (e: MemoryEntryItem) =>
    doneRe.test(e.content + " " + (e.title || ""));
  const progressDone = progress.filter(isDone).length;
  const progressPending = progress.length - progressDone;
  const totalSteps = progress.length + decisions.length;
  const completed = progressDone + decisions.length;
  const pct = totalSteps === 0 ? 0 : Math.round((completed / totalSteps) * 100);

  // Chronological river combining progress + decisions (oldest first).
  const tsOf = (e: MemoryEntryItem) => e.updated_at || e.created_at || "";
  const river = [
    ...progress.map((e) => ({
      item: e,
      kind: isDone(e) ? "progress" : "progress-pending",
      ts: tsOf(e),
    })),
    ...decisions.map((e) => ({
      item: e,
      kind: "decision",
      ts: tsOf(e),
    })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const [primaryAnchor, ...restAnchors] = anchors;
  const empty =
    anchors.length === 0 && progress.length === 0 && decisions.length === 0;

  // Progress ring geometry
  const R = 22;
  const C = 2 * Math.PI * R;
  const off = C * (1 - pct / 100);

  if (empty) {
    return (
      <div className="px-3 py-3">
        <div
          className="text-center py-10 text-xs"
          style={{ color: "var(--fg-3)" }}
        >
          暂无项目锚点与进度。
          <br />
          点击右上角“编辑”添加 Anchor / Progress 后会显示在这里。
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-3">
      <div className="an-journey">
        {primaryAnchor && (
          <div className="an-anchor-node">
            <div className="an-ring">
              <svg viewBox="0 0 52 52">
                <circle className="an-ring-track" cx="26" cy="26" r={R} />
                <circle
                  className="an-ring-fill"
                  cx="26"
                  cy="26"
                  r={R}
                  strokeDasharray={C}
                  strokeDashoffset={off}
                />
              </svg>
              <div className="an-ring-pct">{pct}%</div>
            </div>
            <div className="an-info">
              <div className="an-tg">Anchor</div>
              {primaryAnchor.title && (
                <div
                  className="an-tx"
                  style={{ fontWeight: 600, marginBottom: 2 }}
                >
                  {primaryAnchor.title}
                </div>
              )}
              <div className="an-tx">
                <MessageMarkdown text={primaryAnchor.content} />
              </div>
              <div className="an-mt">
                {completed} / {totalSteps} 步
                {primaryAnchor.updated_at && (
                  <> · {new Date(primaryAnchor.updated_at).toLocaleString()}</>
                )}
              </div>
            </div>
          </div>
        )}

        {restAnchors.length > 0 && (
          <div style={{ marginTop: 8, paddingLeft: 2 }}>
            {restAnchors.map((a) => (
              <div
                key={a.entry_id}
                style={{
                  fontSize: 11.5,
                  color: "var(--fg-2)",
                  padding: "4px 0",
                  display: "flex",
                  gap: 6,
                  alignItems: "baseline",
                }}
              >
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    display: "inline-block",
                    marginRight: 4,
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1 }}>{a.title || a.content}</span>
                {a.updated_at && (
                  <span style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                    {new Date(a.updated_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="an-legend">
          <span className="an-lg decision">
            <span className="an-sq" />
            Decision
          </span>
          <span className="an-lg progress">
            <span className="an-sq" />
            Progress
          </span>
          <span className="an-lg todo">
            <span className="an-sq" />
            Pending
          </span>
        </div>

        {river.length > 0 && (
          <>
            <div className="an-sh first">Path so far</div>
            <div className="an-river">
              {river.map(({ item, kind }) => {
                const isPending = kind === "progress-pending";
                const rowCls = isPending
                  ? "an-riv todo"
                  : kind === "decision"
                    ? "an-riv decision"
                    : "an-riv progress";
                const kindLabel =
                  kind === "decision"
                    ? "Decision"
                    : isPending
                      ? "In progress"
                      : "Progress";
                return (
                  <div key={item.entry_id} className={rowCls}>
                    <span className="an-marker" />
                    <div className="an-card">
                      <div className="an-kind">{kindLabel}</div>
                      {item.title && (
                        <div
                          className="an-tx"
                          style={{ fontWeight: 600, marginBottom: 2 }}
                        >
                          {item.title}
                        </div>
                      )}
                      <div className="an-tx">
                        <MessageMarkdown text={item.content} />
                      </div>
                      {item.updated_at && (
                        <div className="an-mt">
                          {new Date(item.updated_at).toLocaleString()}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="an-end-node">
          <div className="an-cir" />
          <div className="an-tx">
            <b>Goal state.</b>{" "}
            {progressPending === 0 && totalSteps > 0
              ? "All known steps complete."
              : progressPending > 0
                ? `${progressPending} step${progressPending === 1 ? "" : "s"} in progress toward anchor.`
                : "Waiting on first progress entry."}
          </div>
        </div>
      </div>
    </div>
  );
}
