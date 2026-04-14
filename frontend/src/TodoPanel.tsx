import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { isMemberOrAbove, isAdmin as isAdminRole, getStoredRole } from './permissions';

function getToken(): string | null {
  try {
    const stored = localStorage.getItem('currentUser');
    if (!stored) return null;
    const data = JSON.parse(stored);
    if (data.loginTime && Date.now() - data.loginTime < 86400000) {
      return data.token ?? data.user?.user_id ?? null;
    }
  } catch {}
  return null;
}

export type TodoItem = {
  todo_id: string;
  channel_id: string;
  creator_id: string;
  creator_type: string;
  assignee_id: string | null;
  assignee_type: string | null;
  content: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type MemberItem = {
  member_id: string;
  member_type: string;
  username?: string;
  display_name?: string;
};

type TodoPanelProps = {
  channelId: string;
  onClose: () => void;
};

export default function TodoPanel({ channelId, onClose }: TodoPanelProps) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [assigneeVal, setAssigneeVal] = useState('');
  const userRole = getStoredRole();
  const canEdit = isMemberOrAbove(userRole);
  const currentUserId = (() => { try { const s = localStorage.getItem('currentUser'); return s ? JSON.parse(s).user?.user_id : null; } catch { return null; } })();
  const canDeleteTodo = (todo: TodoItem) => isAdminRole(userRole) || todo.creator_id === currentUserId;

  const loadTodos = async () => {
    setLoading(true);
    try {
      const token = getToken();
      const res = await fetch(`/api/v1/channels/${channelId}/todos/`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setTodos(await res.json());
      } else {
        toast.error('Failed to load todos');
      }
    } catch {
      toast.error('Error loading todos');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!channelId) return;
    loadTodos();
    const token = getToken();
    fetch(`/api/v1/channels/${channelId}/members?with_username=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() : { data: [] })
      .then((json) => setMembers(Array.isArray(json) ? json : (json.data ?? [])))
      .catch(() => {});
  }, [channelId]);

  const handleCreate = async () => {
    if (!newContent.trim()) return;
    let assignee_id = null;
    let assignee_type = null;
    if (assigneeVal) {
      const [type, id] = assigneeVal.split(':');
      assignee_id = id;
      assignee_type = type;
    }
    const token = getToken();
    try {
      const res = await fetch(`/api/v1/channels/${channelId}/todos/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: newContent, assignee_id, assignee_type }),
      });
      if (res.ok) {
        setNewContent('');
        setAssigneeVal('');
        loadTodos();
      } else {
        toast.error('Failed to create todo');
      }
    } catch {
      toast.error('Error creating todo');
    }
  };

  const handleToggle = async (todo: TodoItem) => {
    const newStatus = todo.status === 'completed' ? 'pending' : 'completed';
    const token = getToken();
    try {
      const res = await fetch(`/api/v1/channels/${channelId}/todos/${todo.todo_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) loadTodos();
    } catch {
      toast.error('Error updating todo');
    }
  };

  const handleDelete = async (todoId: string) => {
    const token = getToken();
    try {
      const res = await fetch(`/api/v1/channels/${channelId}/todos/${todoId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) loadTodos();
    } catch {
      toast.error('Error deleting todo');
    }
  };

  const getAssigneeName = (id: string, type: string) => {
    const m = members.find((x) => x.member_id === id && x.member_type === type);
    return m ? m.display_name || m.username || 'Unknown' : 'Unknown';
  };

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 flex-shrink-0">
        <span className="text-sm font-semibold text-gray-800">待办事项</span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Create form */}
      <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0 space-y-2">
        <textarea
          rows={2}
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder={canEdit ? "New task..." : "无权限创建任务"}
          disabled={!canEdit}
          className={`w-full text-sm border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400 ${!canEdit ? "opacity-50 cursor-not-allowed bg-gray-50" : ""}`}
        />
        <div className="flex items-center gap-2">
          <select
            value={assigneeVal}
            onChange={(e) => setAssigneeVal(e.target.value)}
            disabled={!canEdit}
            className={`flex-1 text-sm border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:border-blue-400 text-gray-600 ${!canEdit ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            <option value="">Assign to...</option>
            {members.map((m) => (
              <option key={m.member_id} value={`${m.member_type}:${m.member_id}`}>
                {m.member_type === 'bot' ? '🤖 ' : '👤 '}
                {m.display_name || m.username}
              </option>
            ))}
          </select>
          <button
            onClick={handleCreate}
            disabled={!canEdit}
            title={canEdit ? "" : "无权限：访客无法创建任务"}
            className={`px-3 py-1.5 text-sm rounded transition-colors flex-shrink-0 ${canEdit ? "bg-blue-500 text-white hover:bg-blue-600" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
          >
            Add
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16 text-gray-400 text-sm">加载中…</div>
        ) : todos.length === 0 ? (
          <div className="flex items-center justify-center h-16 text-gray-400 text-sm">No tasks yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {todos.map((todo) => (
              <li key={todo.todo_id} className="flex items-start gap-2 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={todo.status === 'completed'}
                  onChange={() => canEdit && handleToggle(todo)}
                  disabled={!canEdit}
                  className={`mt-0.5 flex-shrink-0 ${canEdit ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
                  title={canEdit ? "" : "无权限"}
                />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${todo.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                    {todo.content}
                  </p>
                  {todo.assignee_id && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      Assigned to: {getAssigneeName(todo.assignee_id, todo.assignee_type!)}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => canDeleteTodo(todo) && handleDelete(todo.todo_id)}
                  disabled={!canDeleteTodo(todo)}
                  title={canDeleteTodo(todo) ? "删除" : "仅创建者或管理员可删除"}
                  className={`flex-shrink-0 w-5 h-5 flex items-center justify-center transition-colors text-xs ${canDeleteTodo(todo) ? "text-gray-300 hover:text-red-400" : "text-gray-200 cursor-not-allowed"}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
