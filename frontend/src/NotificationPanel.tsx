import { useEffect, useState } from "react";
import { AppIcon } from "./components/icons/AppIcon";

const API = "/api/v1";

type NotificationItem = {
  notif_type: "mention" | "todo" | "friend_request";
  id: string;
  channel_id: string;
  channel_name: string;
  content: string;
  created_at: string;
  sender_id?: string | null;
  sender_type?: string | null;
  todo_status?: string | null;
  friendship_id?: string | null;
  friend_request_status?: string | null;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  userToken?: string;
  onNavigate: (channelId: string, msgId?: string) => void;
};

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
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
  const friendRequests = items.filter((n) => n.notif_type === "friend_request");

  return (
    <div className="fixed inset-0 z-[80] flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="an-token-panel relative ml-auto flex h-full w-96 max-w-full flex-col border-l border-[var(--border)] bg-[var(--bg-1)] shadow-xl">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <span className="an-type-title">Notifications</span>
          <button
            type="button"
            onClick={onClose}
            className="an-btn an-btn-ghost an-btn-icon"
            aria-label="Close notifications"
            title="Close notifications"
          >
            <AppIcon name="close" className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="an-type-meta flex h-24 items-center justify-center">Loading...</div>
          ) : items.length === 0 ? (
            <div className="an-type-meta flex h-40 flex-col items-center justify-center gap-2">
              <AppIcon name="notification" className="h-9 w-9 opacity-35" />
              <p>No notifications</p>
            </div>
          ) : (
            <>
              {friendRequests.length > 0 && (
                <Section
                  title={`Friend requests (${friendRequests.length})`}
                  items={friendRequests}
                  onNavigate={(n) => { onNavigate(n.channel_id, n.id); onClose(); }}
                />
              )}
              {mentions.length > 0 && (
                <Section
                  title={`@mentions (${mentions.length})`}
                  items={mentions}
                  onNavigate={(n) => { onNavigate(n.channel_id, n.id); onClose(); }}
                />
              )}
              {todos.length > 0 && (
                <Section
                  title={`Todo assignments (${todos.length})`}
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
      <div className="an-type-caption border-b border-[var(--border)] bg-[var(--bg-0)] px-4 py-2 font-semibold uppercase">
        {title}
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {items.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => onNavigate(n)}
              className="w-full px-4 py-3 text-left transition-colors hover:bg-[var(--surface-soft)]"
            >
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 mt-0.5">
                  {n.notif_type === "mention" ? (
                    <AppIcon name="messageCircle" className="w-5 h-5 text-[var(--accent)]" />
                  ) : n.notif_type === "friend_request" ? (
                    <AppIcon name="userPlus" className="w-5 h-5 text-[var(--green)]" />
                  ) : n.todo_status === "completed" ? (
                    <AppIcon name="checkCircle" className="w-5 h-5 text-[var(--green)]" />
                  ) : (
                    <AppIcon name="copy" className="h-5 w-5 text-[var(--fg-3)]" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="an-type-label text-[var(--accent)]">
                      {n.notif_type === "friend_request" ? "Notifications" : `#${n.channel_name}`}
                    </span>
                    <span className="an-type-caption">{timeAgo(n.created_at)}</span>
                  </div>
                  <p className="an-type-meta line-clamp-2 leading-relaxed">{n.content}</p>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
