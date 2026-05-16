import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import { DangerButton, Field, PrimaryButton, inputCls } from "../shared/SettingsControls";

// ── Bulletin pane ─────────────────────────────────────────────────────────

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
};

const PRIORITY_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

export function BulletinPane({
  authToken,
  currentUserId,
  userRole,
}: {
  authToken: string | null;
  currentUserId: string;
  userRole: string;
}) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newPriority, setNewPriority] = useState<"low" | "medium" | "high">("medium");
  const [creating, setCreating] = useState(false);
  const isAdmin = userRole === "system_admin" || userRole === "space_admin";

  const reload = async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/bulletin/issues", { token: authToken });
      const data = await res.json();
      if (data?.status === "success") setIssues(data.data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch("/bulletin/issues", {
        method: "POST",
        token: authToken,
        body: {
          title: newTitle.trim(),
          content: newContent || null,
          priority: newPriority,
          tags: [],
        },
      });
      if (res.ok) {
        setShowCreate(false);
        setNewTitle("");
        setNewContent("");
        setNewPriority("medium");
        reload();
        toast.success("Posted");
      } else {
        const d = await res.json();
        toast.error(d?.detail || "Create failed");
      }
    } finally {
      setCreating(false);
    }
  };

  const toggleStatus = async (issue: Issue) => {
    const next = issue.status === "open" ? "closed" : "open";
    const res = await apiFetch(`/bulletin/issues/${issue.issue_id}`, {
      method: "PATCH",
      token: authToken,
      body: { status: next },
    });
    if (res.ok) reload();
  };

  const remove = async (issue: Issue) => {
    if (!confirm(`Delete "${issue.title}"?`)) return;
    const res = await apiFetch(`/bulletin/issues/${issue.issue_id}`, {
      method: "DELETE",
      token: authToken,
    });
    if (res.ok) reload();
  };

  const canManage = (issue: Issue) =>
    !!authToken && (issue.creator_id === currentUserId || isAdmin);

  return (
    <div className="an-pane">
      <div className="an-pane-head" style={{ justifyContent: "space-between" }}>
        <div>
          <div className="an-pane-title">Bulletin</div>
          <div className="an-pane-sub">Public feedback and change log.</div>
        </div>
        {authToken && (
          <PrimaryButton onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Cancel" : "+ New"}
          </PrimaryButton>
        )}
      </div>
      <div className="an-list-table">
        {showCreate && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">New issue</div>
            <Field label="Title">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className={inputCls}
                autoFocus
              />
            </Field>
            <Field label="Detailed description (optional)">
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={3}
                className={`${inputCls} resize-none`}
              />
            </Field>
            <Field label="Priority">
              <div className="an-seg">
                {(["low", "medium", "high"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={newPriority === p ? "on" : ""}
                    onClick={() => setNewPriority(p)}
                  >
                    {PRIORITY_LABEL[p]}
                  </button>
                ))}
              </div>
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <PrimaryButton onClick={create} disabled={creating || !newTitle.trim()}>
                {creating ? "Submitting..." : "Submit"}
              </PrimaryButton>
            </div>
          </div>
        )}

        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            Loading...
          </div>
        ) : issues.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            No issues
          </div>
        ) : (
          issues.map((it) => (
            <div key={it.issue_id} className="an-row-card" style={{ alignItems: "flex-start" }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  marginTop: 6,
                  background:
                    it.status === "open"
                      ? "var(--green)"
                      : it.status === "resolved"
                        ? "var(--accent)"
                        : "var(--fg-3)",
                  flexShrink: 0,
                }}
                title={it.status}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">{it.title}</div>
                {it.content && (
                  <div
                    className="an-rc-sub"
                    style={{
                      whiteSpace: "pre-wrap",
                      maxHeight: 60,
                      overflow: "hidden",
                    }}
                  >
                    {it.content}
                  </div>
                )}
                <div className="an-rc-sub" style={{ marginTop: 4 }}>
                  {it.creator_name || "Anonymous"} · {PRIORITY_LABEL[it.priority]}Priority
                </div>
              </div>
              {canManage(it) && (
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => toggleStatus(it)}
                    className="an-btn an-btn-sm"
                  >
                    {it.status === "open" ? "Close" : "Open"}
                  </button>
                  <DangerButton onClick={() => remove(it)}>Delete</DangerButton>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
