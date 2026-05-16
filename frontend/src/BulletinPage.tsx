import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppIcon } from "./components/icons/AppIcon";
import { Modal, ModalFooter } from "./components/Modal";

const API = "/api/v1";

type Issue = {
  issue_id: string;
  title: string;
  content: string | null;
  status: "open" | "closed" | "resolved";
  priority: "low" | "medium" | "high";
  tags: string[];
  creator_id: string | null;
  creator_name: string | null;
  created_at: string;
  updated_at: string;
};

const PRIORITY_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };
const PRIORITY_CHIP_CLASS: Record<string, string> = {
  low: "off",
  medium: "orange",
  high: "red",
};
const STATUS_LABEL: Record<Issue["status"], string> = { open: "Open", closed: "Closed", resolved: "Resolved" };
const STATUS_CHIP_CLASS: Record<Issue["status"], string> = { open: "green", closed: "off", resolved: "blue" };

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
}

function getStoredAuth() {
  try {
    const stored = localStorage.getItem("currentUser");
    if (!stored) return { token: null, userId: null, isAdmin: false, isSystemAdmin: false };
    const data = JSON.parse(stored);
    if (data.loginTime && Date.now() - data.loginTime < 86400000) {
      const role = data.user?.role ?? "";
      return {
        token: data.token ?? data.user?.user_id ?? null,
        userId: data.user?.user_id ?? null,
        isAdmin: role === "system_admin" || role === "space_admin",
        isSystemAdmin: role === "system_admin",
      };
    }
  } catch {}
  return { token: null, userId: null, isAdmin: false, isSystemAdmin: false };
}

export default function BulletinPage() {
  const [auth] = useState(getStoredAuth);
  const authToken = auth.token;
  const currentUserId = auth.userId;
  const isAdmin = auth.isAdmin;
  const isSystemAdmin = auth.isSystemAdmin;

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<"" | "open" | "closed" | "resolved">("");
  const [filterPriority, setFilterPriority] = useState<"" | "low" | "medium" | "high">("");

  // created modal state
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newPriority, setNewPriority] = useState<"low" | "medium" | "high">("medium");
  const [newTags, setNewTags] = useState("");
  const [creating, setCreating] = useState(false);

  // Detail modal state
  const [detailIssue, setDetailIssue] = useState<Issue | null>(null);

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

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filterStatus) params.set("status", filterStatus);
    if (filterPriority) params.set("priority", filterPriority);
    try {
      const res = await fetch(`${API}/bulletin/issues?${params}`);
      const data = await res.json();
      if (data.status === "success") setIssues(data.data);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterPriority]);

  useEffect(() => {
    fetchIssues();
  }, [fetchIssues]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const tags = newTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await authFetch(`${API}/bulletin/issues`, {
        method: "POST",
        body: JSON.stringify({ title: newTitle.trim(), content: newContent || null, priority: newPriority, tags }),
      });
      if (res.ok) {
        setShowCreate(false);
        setNewTitle("");
        setNewContent("");
        setNewPriority("medium");
        setNewTags("");
        fetchIssues();
      } else {
        const d = await res.json();
        alert(d.detail || "Create failed");
      }
    } finally {
      setCreating(false);
    }
  };

  const handleToggleStatus = async (issue: Issue) => {
    const nextStatus = issue.status === "open" ? "closed" : "open";
    const res = await authFetch(`${API}/bulletin/issues/${issue.issue_id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    if (res.ok) {
      fetchIssues();
      if (detailIssue?.issue_id === issue.issue_id) {
        setDetailIssue({ ...detailIssue, status: nextStatus });
      }
    }
  };

  const handleResolve = async (issue: Issue) => {
    const res = await authFetch(`${API}/bulletin/issues/${issue.issue_id}/resolve`, {
      method: "PATCH",
    });
    if (res.ok) {
      fetchIssues();
      if (detailIssue?.issue_id === issue.issue_id) {
        setDetailIssue({ ...detailIssue, status: "resolved" });
      }
    } else {
      const d = await res.json();
      alert(d.detail || "Operation failed");
    }
  };

  const handleDelete = async (issue: Issue) => {
    if (!confirm(`Delete "${issue.title}"?`)) return;
    const res = await authFetch(`${API}/bulletin/issues/${issue.issue_id}`, { method: "DELETE" });
    if (res.ok) {
      fetchIssues();
      if (detailIssue?.issue_id === issue.issue_id) setDetailIssue(null);
    }
  };

  const canManage = (issue: Issue) =>
    authToken && (issue.creator_id === currentUserId || isAdmin);

  return (
    <div className="an-token-page flex min-h-screen flex-col">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-[var(--border)] bg-[var(--bg-1)] px-6 py-3">
        <Link to="/" className="an-btn an-btn-ghost an-btn-sm">
          <AppIcon name="arrowLeft" className="w-4 h-4" />
          Back
        </Link>
        <h1 className="an-type-title">Public bulletin</h1>
        <span className="an-type-meta ml-1">Issues</span>
        <div className="flex-1" />
        {authToken && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="an-btn an-btn-primary"
          >
            <AppIcon name="plus" className="w-4 h-4" />
            New issue
          </button>
        )}
      </header>

      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        {/* Filters */}
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as "" | "open" | "closed" | "resolved")}
            className="an-select w-auto min-w-36"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="resolved">Resolved</option>
          </select>
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value as "" | "low" | "medium" | "high")}
            className="an-select w-auto min-w-36"
          >
            <option value="">All priorities</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <span className="an-chip">{issues.length} items</span>
        </div>

        {/* Issue List */}
        {loading ? (
          <div className="an-type-meta py-20 text-center">Loading...</div>
        ) : issues.length === 0 ? (
          <div className="an-type-meta py-20 text-center">No issues{authToken ? ". Click New in the top-right" : ""}</div>
        ) : (
          <ul className="space-y-2">
            {issues.map((issue) => (
              <li
                key={issue.issue_id}
                className="flex items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-4 py-3 transition-colors hover:border-[var(--border-strong)]"
              >
                {/* Status dot */}
                <span
                  className="mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{ background: issue.status === "open" ? "var(--green)" : issue.status === "resolved" ? "var(--blue)" : "var(--fg-3)" }}
                  title={STATUS_LABEL[issue.status]}
                />

                {/* Main content */}
                <div className="flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => setDetailIssue(issue)}
                    className="block w-full truncate text-left font-medium text-[var(--fg-1)] hover:text-[var(--accent)]"
                  >
                    {issue.title}
                  </button>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <span className={`an-chip ${PRIORITY_CHIP_CLASS[issue.priority]}`}>
                      {PRIORITY_LABEL[issue.priority]}Priority
                    </span>
                    {issue.tags?.map((tag) => (
                      <span key={tag} className="an-chip accent">
                        {tag}
                      </span>
                    ))}
                    <span className="an-type-caption">
                      {issue.creator_name || "Anonymous"} · {formatDate(issue.created_at)}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {isSystemAdmin && issue.status !== "resolved" && (
                    <button
                      type="button"
                      onClick={() => handleResolve(issue)}
                      className="an-btn an-btn-primary an-btn-sm"
                      title="Mark as resolved"
                    >
                      Resolved
                    </button>
                  )}
                  {canManage(issue) && (
                    <>
                      <button
                        onClick={() => handleToggleStatus(issue)}
                        className="an-btn an-btn-sm"
                        title={issue.status === "open" ? "Close" : "Reopen"}
                      >
                        {issue.status === "open" ? "Close" : "Open"}
                      </button>
                      <button
                        onClick={() => handleDelete(issue)}
                        className="an-btn an-btn-danger an-btn-sm"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* created Modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New issue"
        maxWidth="max-w-lg"
        panelClassName="an-token-panel"
      >
        <div className="space-y-4">
              <div className="an-field">
                <label className="an-label">Title *</label>
                <input
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="an-input"
                  placeholder="Briefly describe the issue or idea"
                />
              </div>
              <div className="an-field">
                <label className="an-label">Details</label>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  rows={4}
                  className="an-textarea resize-none"
                  placeholder="Optional, plain text supported"
                />
              </div>
              <div className="flex gap-4">
                <div className="an-field flex-1">
                  <label className="an-label">Priority</label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as "low" | "medium" | "high")}
                    className="an-select"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
                <div className="an-field flex-1">
                  <label className="an-label">Tags (comma separated)</label>
                  <input
                    value={newTags}
                    onChange={(e) => setNewTags(e.target.value)}
                    className="an-input"
                    placeholder="bug, feature request"
                  />
                </div>
              </div>
        </div>
        <ModalFooter>
          <button type="button" onClick={() => setShowCreate(false)} className="an-btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !newTitle.trim()}
            className="an-btn an-btn-primary"
          >
            {creating ? "Submitting..." : "Submit"}
          </button>
        </ModalFooter>
      </Modal>

      {/* Detail Modal */}
      <Modal
        open={!!detailIssue}
        onClose={() => setDetailIssue(null)}
        title={detailIssue?.title}
        maxWidth="max-w-lg"
        panelClassName="an-token-panel max-h-[80vh] overflow-hidden"
      >
        {detailIssue && (
          <div className="flex max-h-[60vh] flex-col">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className={`an-chip ${STATUS_CHIP_CLASS[detailIssue.status]}`}>
                {STATUS_LABEL[detailIssue.status]}
              </span>
              <span className={`an-chip ${PRIORITY_CHIP_CLASS[detailIssue.priority]}`}>
                {PRIORITY_LABEL[detailIssue.priority]}Priority
              </span>
              {detailIssue.tags?.map((tag) => (
                <span key={tag} className="an-chip accent">
                  {tag}
                </span>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {detailIssue.content ? (
                <p className="an-type-body whitespace-pre-wrap">{detailIssue.content}</p>
              ) : (
                <p className="an-type-meta italic">No details</p>
              )}
              <p className="an-type-caption mt-4">
                By {detailIssue.creator_name || "Anonymous"} at {formatDate(detailIssue.created_at)} created
              </p>
            </div>
            {(canManage(detailIssue) || isSystemAdmin) && (
              <ModalFooter>
                {isSystemAdmin && detailIssue.status !== "resolved" && (
                  <button
                    type="button"
                    onClick={() => handleResolve(detailIssue)}
                    className="an-btn an-btn-primary"
                  >
                    Mark resolved
                  </button>
                )}
                {canManage(detailIssue) && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(detailIssue)}
                      className="an-btn"
                    >
                      {detailIssue.status === "open" ? "Close issue" : "Reopen"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(detailIssue)}
                      className="an-btn an-btn-danger"
                    >
                      Delete
                    </button>
                  </>
                )}
              </ModalFooter>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
