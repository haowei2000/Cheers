import { useEffect, useState } from "react";
import {
  ChatBubbleLeftIcon,
  CheckCircleIcon,
} from "@heroicons/react/24/solid";
import { Square2StackIcon } from "@heroicons/react/24/outline";

const API = "/api/v1";

type NotificationItem = {
  notif_type: "mention" | "todo";
  id: string;
  channel_id: string;
  channel_name: string;
  content: string;
  created_at: string;
  sender_id?: string | null;
  sender_type?: string | null;
  todo_status?: string | null;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  userToken?: string;
  onNavigate: (channelId: string, msgId?: string) => void;
};

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

export default function NotificationPanel({ isOpen, onClose, userToken, onNavigate }: Props) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const headers: Record<string, string> = userToken ? { Authorization: `Bearer ${userToken}` } : {};

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    fetch(`${API}/notifications/`, { headers })
      .then((r) => r.ok ? r.json() : [])
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen]);

  if (!isOpen) return null;

  const mentions = items.filter((n) => n.notif_type === "mention");
  const todos = items.filter((n) => n.notif_type === "todo");

  return (
    <div className="fixed inset-0 z-[80] flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="relative ml-auto h-full w-96 max-w-full bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <span className="text-sm font-semibold text-gray-900">通知</span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-24 text-gray-400 text-sm">加载中…</div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-400 gap-2">
              <span className="text-4xl opacity-30">🔔</span>
              <p className="text-sm">暂无通知</p>
            </div>
          ) : (
            <>
              {mentions.length > 0 && (
                <Section
                  title={`@提及 (${mentions.length})`}
                  items={mentions}
                  onNavigate={(n) => { onNavigate(n.channel_id, n.id); onClose(); }}
                />
              )}
              {todos.length > 0 && (
                <Section
                  title={`待办指派 (${todos.length})`}
                  items={todos}
                  onNavigate={(n) => { onNavigate(n.channel_id); onClose(); }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  items,
  onNavigate,
}: {
  title: string;
  items: NotificationItem[];
  onNavigate: (n: NotificationItem) => void;
}) {
  return (
    <div>
      <div className="px-4 py-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
        {title}
      </div>
      <ul className="divide-y divide-gray-100">
        {items.map((n) => (
          <li key={n.id}>
            <button
              onClick={() => onNavigate(n)}
              className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 mt-0.5">
                  {n.notif_type === "mention" ? (
                    <ChatBubbleLeftIcon className="w-5 h-5 text-[#1264A3]" />
                  ) : n.todo_status === "completed" ? (
                    <CheckCircleIcon className="w-5 h-5 text-[#2EB67D]" />
                  ) : (
                    <Square2StackIcon className="w-5 h-5 text-gray-400" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-xs font-medium text-[#1264A3]">#{n.channel_name}</span>
                    <span className="text-[10px] text-gray-400">{timeAgo(n.created_at)}</span>
                  </div>
                  <p className="text-xs text-gray-700 line-clamp-2 leading-relaxed">{n.content}</p>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
