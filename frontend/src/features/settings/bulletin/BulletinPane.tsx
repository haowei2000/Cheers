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

const PRIORITY_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };

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
        toast.success("已发布");
      } else {
        const d = await res.json();
        toast.error(d?.detail || "创建失败");
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
    if (!confirm(`确定删除「${issue.title}」？`)) return;
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
          <div className="an-pane-title">留言板</div>
          <div className="an-pane-sub">公共反馈与变更记录。</div>
        </div>
        {authToken && (
          <PrimaryButton onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "取消" : "+ 新建"}
          </PrimaryButton>
        )}
      </div>
      <div className="an-list-table">
        {showCreate && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">新建 Issue</div>
            <Field label="标题">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className={inputCls}
                autoFocus
              />
            </Field>
            <Field label="详细描述（可选）">
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={3}
                className={`${inputCls} resize-none`}
              />
            </Field>
            <Field label="优先级">
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
                {creating ? "提交中…" : "提交"}
              </PrimaryButton>
            </div>
          </div>
        )}

        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            加载中…
          </div>
        ) : issues.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            暂无 Issue
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
                  {it.creator_name || "匿名"} · {PRIORITY_LABEL[it.priority]}优先级
                </div>
              </div>
              {canManage(it) && (
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => toggleStatus(it)}
                    style={{
                      padding: "4px 8px",
                      fontSize: 11,
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      background: "transparent",
                      color: "var(--fg-2)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {it.status === "open" ? "关闭" : "开放"}
                  </button>
                  <DangerButton onClick={() => remove(it)}>删除</DangerButton>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
