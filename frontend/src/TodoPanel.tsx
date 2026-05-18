import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import type { TodoItem, MemberItem } from './types';
import { getAuthToken as getToken } from './api';

export type { TodoItem };

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
        <span className="text-sm font-semibold text-gray-800">Todos</span>
        <button
          onClick={onClose}
          aria-label="Close panel"
          className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          ✕
        </button>
      </div>

      {/* created form */}
      <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0 space-y-2">
        <textarea
          rows={2}
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="New task..."
          className="w-full text-sm border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400"
        />
        <div className="flex items-center gap-2">
          <select
            value={assigneeVal}
            onChange={(e) => setAssigneeVal(e.target.value)}
            className="flex-1 text-sm border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:border-blue-400 text-gray-600"
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
            className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors flex-shrink-0"
          >
            Add
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16 text-gray-400 text-sm">Loading...</div>
        ) : todos.length === 0 ? (
          <div className="flex items-center justify-center h-16 text-gray-400 text-sm">No tasks yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {todos.map((todo) => (
              <li key={todo.todo_id} className="flex items-start gap-2 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={todo.status === 'completed'}
                  onChange={() => handleToggle(todo)}
                  className="mt-0.5 flex-shrink-0 cursor-pointer"
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
                  onClick={() => handleDelete(todo.todo_id)}
                  className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-gray-300 hover:text-red-400 transition-colors text-xs"
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
