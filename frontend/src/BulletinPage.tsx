import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

const API = "/api";

type Issue = {
  issue_id: string;
  title: string;
  content: string | null;
  status: "open" | "closed";
  priority: "low" | "medium" | "high";
  tags: string[];
  creator_id: string | null;
  creator_name: string | null;
  created_at: string;
  updated_at: string;
};

const PRIORITY_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };
const PRIORITY_COLOR: Record<string, string> = {
  low: "bg-gray-100 text-gray-600",
  medium: "bg-yellow-100 text-yellow-700",
  high: "bg-red-100 text-red-700",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
}

function getStoredAuth() {
  try {
    const stored = localStorage.getItem("currentUser");
    if (!stored) return { token: null, userId: null, isAdmin: false };
    const data = JSON.parse(stored);
    if (data.loginTime && Date.now() - data.loginTime < 86400000) {
      return {
        token: data.token ?? data.user?.user_id ?? null,
        userId: data.user?.user_id ?? null,
        isAdmin: data.user?.role === "admin"
      };
    }
  } catch {}
  return { token: null, userId: null, isAdmin: false };
}

export default function BulletinPage() {
  const [auth] = useState(getStoredAuth);
  const authToken = auth.token;
  const currentUserId = auth.userId;
  const isAdmin = auth.isAdmin;

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<"" | "open" | "closed">("");
  const [filterPriority, setFilterPriority] = useState<"" | "low" | "medium" | "high">("");

  // Create modal state
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
        alert(d.detail || "创建失败");
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

  const handleDelete = async (issue: Issue) => {
    if (!confirm(`确定删除「${issue.title}」？`)) return;
    const res = await authFetch(`${API}/bulletin/issues/${issue.issue_id}`, { method: "DELETE" });
    if (res.ok) {
      fetchIssues();
      if (detailIssue?.issue_id === issue.issue_id) setDetailIssue(null);
    }
  };

  const canManage = (issue: Issue) =>
    authToken && (issue.creator_id === currentUserId || isAdmin);

  return (
    <div className="min-h-screen bg-[#F8F9FA] flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <Link to="/" className="text-gray-500 hover:text-gray-800 text-sm flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
          </svg>
          返回
        </Link>
        <h1 className="text-lg font-semibold text-gray-800">公共留言板</h1>
        <span className="text-xs text-gray-400 ml-1">Issues</span>
        <div className="flex-1" />
        {authToken && (
          <button
            onClick={() => setShowCreate(true)}
            className="bg-[#1264A3] text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-[#0D5180] transition-colors"
          >
            + 新建 Issue
          </button>
        )}
      </header>

      <div className="flex-1 max-w-4xl w-full mx-auto px-4 py-6">
        {/* Filters */}
        <div className="flex gap-3 mb-5">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as "" | "open" | "closed")}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white text-gray-700"
          >
            <option value="">全部状态</option>
            <option value="open">开放</option>
            <option value="closed">已关闭</option>
          </select>
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value as "" | "low" | "medium" | "high")}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white text-gray-700"
          >
            <option value="">全部优先级</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
          <span className="text-sm text-gray-500 self-center">{issues.length} 条</span>
        </div>

        {/* Issue List */}
        {loading ? (
          <div className="text-center text-gray-400 py-20">加载中...</div>
        ) : issues.length === 0 ? (
          <div className="text-center text-gray-400 py-20">暂无 Issue{authToken ? "，点击右上角新建" : ""}</div>
        ) : (
          <ul className="space-y-2">
            {issues.map((issue) => (
              <li
                key={issue.issue_id}
                className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex items-start gap-3 hover:border-gray-300 transition-colors"
              >
                {/* Status dot */}
                <span
                  className={`mt-1 flex-shrink-0 w-2.5 h-2.5 rounded-full ${issue.status === "open" ? "bg-green-500" : "bg-gray-400"}`}
                  title={issue.status === "open" ? "开放" : "已关闭"}
                />

                {/* Main content */}
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => setDetailIssue(issue)}
                    className="font-medium text-gray-800 hover:text-[#1264A3] text-left truncate block w-full"
                  >
                    {issue.title}
                  </button>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${PRIORITY_COLOR[issue.priority]}`}
                    >
                      {PRIORITY_LABEL[issue.priority]}优先级
                    </span>
                    {issue.tags?.map((tag) => (
                      <span key={tag} className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">
                        {tag}
                      </span>
                    ))}
                    <span className="text-xs text-gray-400">
                      {issue.creator_name || "匿名"} · {formatDate(issue.created_at)}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                {canManage(issue) && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleToggleStatus(issue)}
                      className="text-xs text-gray-500 hover:text-gray-800 px-2 py-1 rounded hover:bg-gray-100"
                      title={issue.status === "open" ? "关闭" : "重新开放"}
                    >
                      {issue.status === "open" ? "关闭" : "开放"}
                    </button>
                    <button
                      onClick={() => handleDelete(issue)}
                      className="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
                    >
                      删除
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="font-semibold text-gray-800">新建 Issue</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-600">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">标题 *</label>
                <input
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1264A3]"
                  placeholder="简要描述问题或想法"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">详细描述</label>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  rows={4}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1264A3] resize-none"
                  placeholder="可选，支持纯文本"
                />
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">优先级</label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as "low" | "medium" | "high")}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white"
                  >
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">标签（逗号分隔）</label>
                  <input
                    value={newTags}
                    onChange={(e) => setNewTags(e.target.value)}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1264A3]"
                    placeholder="bug, 功能请求"
                  />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t">
              <button
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newTitle.trim()}
                className="px-4 py-2 text-sm bg-[#1264A3] text-white rounded hover:bg-[#0D5180] disabled:opacity-50"
              >
                {creating ? "提交中..." : "提交"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detailIssue && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="flex items-start justify-between px-5 py-4 border-b gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold text-gray-800 break-words">{detailIssue.title}</h2>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${detailIssue.status === "open" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}
                  >
                    {detailIssue.status === "open" ? "开放" : "已关闭"}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${PRIORITY_COLOR[detailIssue.priority]}`}>
                    {PRIORITY_LABEL[detailIssue.priority]}优先级
                  </span>
                  {detailIssue.tags?.map((tag) => (
                    <span key={tag} className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => setDetailIssue(null)} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {detailIssue.content ? (
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{detailIssue.content}</p>
              ) : (
                <p className="text-sm text-gray-400 italic">无详细描述</p>
              )}
              <p className="text-xs text-gray-400 mt-4">
                由 {detailIssue.creator_name || "匿名"} 于 {formatDate(detailIssue.created_at)} 创建
              </p>
            </div>
            {canManage(detailIssue) && (
              <div className="flex justify-end gap-2 px-5 py-4 border-t">
                <button
                  onClick={() => handleToggleStatus(detailIssue)}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 text-gray-700"
                >
                  {detailIssue.status === "open" ? "关闭 Issue" : "重新开放"}
                </button>
                <button
                  onClick={() => handleDelete(detailIssue)}
                  className="px-3 py-1.5 text-sm bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100"
                >
                  删除
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
