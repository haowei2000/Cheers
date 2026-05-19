import { useEffect, useState, type MouseEvent } from "react";
import toast from "react-hot-toast";
import { MessageMarkdown } from "../MessageMarkdown";
import type { MemberItem, TodoItem, MemoryEntryItem } from "../types";
import { LAYERS } from "../types";
import { LAYER_META } from "../lib/layer-meta";
import { getAuthToken as getStoredToken } from "../api";
import { AppIcon, FileTypeIcon } from "./icons";
import { InviteMemberSearch } from "./InviteMemberSearch";
import { SearchPicker } from "./SearchPicker";
import { QuickAddFooter } from "../features/memory/editor/QuickAddFooter";
import type { ChannelFilePreview } from "../features/memory/types";
import { MembersView } from "../features/memory/views/MembersView";
import { ProjectView } from "../features/memory/views/ProjectView";

const API = "/api/v1";
const PANEL_TITLE_BY_LAYER: Record<string, string> = {
  PROJECT: "Project memory",
  ANCHOR: "Project memory",
  PROGRESS: "Project progress",
  DECISIONS: "Decisions",
  FILES_INDEX: "Files",
  MEMBERS: "Members",
  TODO: "Todos",
  RECENT: "Recent activity",
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
    label: "Project memory",
    desc: "Core goals and progress (Anchor + Progress)",
    color: "blue",
    icon: "◆",
    readonly: false,
    entryBased: false,
  };
  const meta = isProject ? PROJECT_META : LAYER_META[activeLayer];
  const panelTitle = PANEL_TITLE_BY_LAYER[activeLayer] || meta.label || "Channel memory";
  const toolbarLabel = activeLayer === "FILES_INDEX" ? "Reference index" : panelTitle;
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

  const handleChannelFileDelete = async (
    file: { file_id: string; original_filename?: string | null },
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (!confirm(`Delete ${file.original_filename || file.file_id}?`)) return;
    const token = getStoredToken();
    try {
      const res = await fetch(
        `${API}/files/${encodeURIComponent(file.file_id)}?channel_id=${encodeURIComponent(channelId)}`,
        {
          method: "DELETE",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.status === "error") {
        throw new Error(payload?.message || payload?.detail || "Delete failed");
      }
      setChannelFiles((files) =>
        files.filter((item) => item.file_id !== file.file_id),
      );
      toast.success("File deleted");
    } catch (error: unknown) {
      toast.error((error as Error).message || "Delete failed");
    }
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
      toast.success("Channel profile updated");
    } catch {
      toast.error("Failed to save channel profile");
    } finally {
      setProfileSaving(false);
    }
  };

  // ── Entry-based layer content renderer ──
  const renderEntryLayer = () => {
    if (entriesLoading) {
      return (
        <div className="flex items-center justify-center h-12 text-gray-400 text-xs">
          Loading...
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-y-auto">
        {/* Entry list */}
        {entries.length === 0 && !addingNew ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 px-4 text-center">
            <span className="block w-8 h-8 opacity-30">{meta.icon}</span>
            <p className="text-xs font-medium text-gray-500">No content</p>
            <p className="text-[11px] text-gray-400">{meta.desc}</p>
            <button
              type="button"
              onClick={() => setAddingNew(true)}
              className="mt-1 text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
            >
              Add entry
            </button>
          </div>
        ) : timelineMode && (activeLayer === "PROGRESS" || activeLayer === "DECISIONS") ? (
          <div className="px-3 py-3">
            <div className="an-tl-title">
              {activeLayer === "DECISIONS" ? "Decisions" : "Progress"} · Timeline
            </div>
            <div className="an-timeline">
              {entries.map((entry) => {
                const isDone = /done|Done|\u5df2\u505a|shipped|merged|resolved|\u6279\u51c6|approved/i.test(
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
                      placeholder="Title (optional)"
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
                        Cancel
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
                        Save
                      </button>
                    </div>
                  </div>
                );
              }
              const isDone = /done|Done|\u5df2\u505a|shipped|merged|resolved|\u6279\u51c6|approved/i.test(
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
                      title="Edit"
                    >
                      &#9998;
                    </button>
                    <button
                      onClick={() => handleDeleteEntry(entry.entry_id)}
                      className="text-[11px] p-1 rounded hover:bg-[var(--surface-soft)]"
                      style={{ color: "var(--fg-3)" }}
                      title="Delete"
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
              placeholder="Title (optional)"
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
              placeholder="Content..."
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
                Cancel
              </button>
              <button
                onClick={handleCreateEntry}
                className="text-[11px] px-2 py-0.5 rounded bg-[#1264A3] text-white hover:bg-[#0f5a94]"
              >
                Add
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
          Loading...
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
              No {labels[projectEditLayer]} content
            </p>
            <button
              type="button"
              onClick={() => setAddingNew(true)}
              className="mt-1 text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
            >
              Add entry
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
                      placeholder="Title (optional)"
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
                        Cancel
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
                        Save
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
                      title="Edit"
                    >
                      &#9998;
                    </button>
                    <button
                      type="button"
                      onClick={() => handleProjectDeleteEntry(entry.entry_id)}
                      className="text-[11px] p-1 rounded hover:bg-[var(--surface-soft)]"
                      style={{ color: "var(--fg-3)" }}
                      title="Delete"
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
              placeholder="Title (optional)"
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
              placeholder="Content..."
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
                Cancel
              </button>
              <button
                type="button"
                onClick={handleProjectCreateEntry}
                className="text-[11px] px-2 py-0.5 rounded bg-[#1264A3] text-white hover:bg-[#0f5a94]"
              >
                Add
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
                Invite members
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
            Loading...
          </div>
        ) : members.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 text-gray-400 gap-2 text-center px-4">
            <AppIcon name="users" className="w-8 h-8 opacity-30" />
            <p className="text-xs text-gray-500">No members</p>
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
          <div className="an-t">{panelTitle}</div>
          {channelName && <div className="an-sub">#{channelName}</div>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--surface-soft)] transition-colors"
            style={{ color: "var(--fg-3)", fontSize: 16, lineHeight: 1 }}
            title="Close"
            aria-label="Close panel"
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
            {toolbarLabel}
          </span>
          {isEntryBased && entries.length > 0 && (
            <span
              className="text-[10px] flex-shrink-0"
              style={{ color: "var(--fg-3)" }}
            >
              {entries.length} items
            </span>
          )}
          {isReadonly && activeLayer !== "TODO" && !canInviteFromMembers && (
            <span
              className="text-[10px] flex-shrink-0"
              style={{ color: "var(--fg-3)" }}
            >
              Read-only
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
              {projectEditing ? "Done" : "Edit"}
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
              + Add
            </button>
          )}
          {isEntryBased &&
            (activeLayer === "PROGRESS" || activeLayer === "DECISIONS") &&
            entries.length > 0 && (
              <div
                className="an-seg"
                style={{ height: 24 }}
                role="group"
                aria-label="View switcher"
              >
                <button
                  type="button"
                  className={!timelineMode ? "on" : ""}
                  onClick={() => setTimelineMode(false)}
                  title="List view"
                >
                  List
                </button>
                <button
                  type="button"
                  className={timelineMode ? "on" : ""}
                  onClick={() => setTimelineMode(true)}
                  title="Timeline view"
                >
                  Timeline
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
              + Add
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
                placeholder="New task..."
                className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400"
              />
              <div className="flex items-center gap-1.5">
                <select
                  value={todoAssignee}
                  onChange={(e) => setTodoAssignee(e.target.value)}
                  className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:border-blue-400 text-gray-500"
                >
                  <option value="">Assign to...</option>
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
                  Add
                </button>
              </div>
            </div>
            {/* Todo list */}
            <div className="flex-1 overflow-y-auto">
              {todosLoading ? (
                <div className="flex items-center justify-center h-12 text-gray-400 text-xs">
                  Loading...
                </div>
              ) : todos.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-20 text-gray-400 gap-1 text-center px-4">
                  <AppIcon name="checkCircle" className="w-6 h-6 opacity-30" />
                  <p className="text-xs text-gray-400">No todos</p>
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
              Loading...
            </div>
          ) : channelFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 px-4 text-center">
              <span className="block w-8 h-8 opacity-30">{meta.icon}</span>
              <p className="text-xs font-medium text-gray-500">No files</p>
              <p className="text-[11px] text-gray-400">
                Current channel memory reference files appear here after upload.
              </p>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="border-b border-gray-100 px-3 py-2">
                <SearchPicker
                  context="file_lookup"
                  channelId={channelId}
                  types={["files"]}
                  modal
                  placeholder="Search file name, summary, or type"
                  emptyText="No matching files"
                  actionLabel="Preview"
                  onSelect={(selection) => {
                    if (selection.type !== "file") return;
                    onFilePreview?.({
                      file_id: selection.item.file_id,
                      original_filename: selection.item.original_filename,
                      content_type: selection.item.content_type,
                      size_bytes: selection.item.size_bytes,
                      channel_id: channelId,
                      channel_label: channelName,
                      scope_type: "channel",
                      scope_id: channelId,
                    });
                  }}
                />
              </div>
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
                        ? "Text"
                        : "Files";
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
                    onClick={() =>
                      onFilePreview?.({
                        ...f,
                        channel_id: channelId,
                        channel_label: channelName,
                        scope_type: "channel",
                        scope_id: channelId,
                      })
                    }
                    onKeyDown={(event) => {
                      if (!onFilePreview) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onFilePreview({
                          ...f,
                          channel_id: channelId,
                          channel_label: channelName,
                          scope_type: "channel",
                          scope_id: channelId,
                        });
                      }
                    }}
                    className={`flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50 transition-colors ${
                      onFilePreview ? "cursor-pointer" : ""
                    }`}
                  >
                    <div className="w-8 h-8 rounded-md bg-gray-50 flex items-center justify-center flex-shrink-0">
                      <FileTypeIcon
                        contentType={f.content_type}
                        filename={f.original_filename || f.file_id}
                        size={26}
                      />
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
                      title="Download file"
                    >
                      <AppIcon name="download" className="w-4 h-4" />
                    </a>
                    <button
                      type="button"
                      onClick={(event) => void handleChannelFileDelete(f, event)}
                      className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors flex-shrink-0"
                      title="Delete file"
                      aria-label="Delete file"
                    >
                      <AppIcon name="trash" className="w-4 h-4" />
                    </button>
                  </div>
                );
                })}
              </div>
            </div>
          )
        ) : rawContent.trim() ? (
          /* Readonly derived layers (history) */
          <div className="px-3 py-3 text-sm overflow-y-auto">
            <MessageMarkdown text={rawContent} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2 px-4 text-center">
            <span className="block w-8 h-8 opacity-30">{meta.icon}</span>
            <p className="text-xs font-medium text-gray-500">No content</p>
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
