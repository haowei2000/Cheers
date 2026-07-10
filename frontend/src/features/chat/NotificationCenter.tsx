import { useState } from "react";
import { Bell } from "lucide-react";
import toast from "react-hot-toast";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useNotificationStore } from "@/stores/notificationStore";
import { useChatStore } from "@/stores/chatStore";
import { listWorkspaces } from "@/api/workspaces";
import { listChannels, listDms } from "@/api/channels";
import {
  acceptNotification,
  declineNotification,
  notificationKey,
  type NotificationItem,
} from "@/api/notifications";

// After accepting an invite the rail (workspaces) and the sidebar (channels of the
// selected workspace) can both change, so re-pull them the same way ChatLayout does.
async function refreshLists() {
  try {
    useChatStore.getState().setWorkspaces(await listWorkspaces());
  } catch {
    /* non-fatal */
  }
  const { selectedWorkspaceId, personalWorkspace, setChannels } =
    useChatStore.getState();
  if (!selectedWorkspaceId) return;
  const isPersonal =
    !!personalWorkspace && selectedWorkspaceId === personalWorkspace.workspace_id;
  try {
    const [chs, dms] = await Promise.all([
      listChannels(selectedWorkspaceId),
      isPersonal ? listDms().catch(() => []) : Promise.resolve([]),
    ]);
    setChannels([...chs, ...dms]);
  } catch {
    /* non-fatal */
  }
}

function label(n: NotificationItem): string {
  return n.kind === "channel_invite" ? `#${n.title}` : n.title;
}

/** Bell button + dropdown inbox of pending invitations (workspace + channel). */
export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const items = useNotificationStore((s) => s.items);
  const remove = useNotificationStore((s) => s.remove);
  const count = items.length;

  async function act(n: NotificationItem, accept: boolean) {
    const key = notificationKey(n);
    setBusy(key);
    try {
      if (accept) await acceptNotification(n);
      else await declineNotification(n);
      remove(n);
      toast.success(accept ? `Joined ${label(n)}` : "Declined");
      if (accept) await refreshLists();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Notifications"
        className="relative w-8 h-8 max-md:w-11 max-md:h-11 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 flex items-center justify-center transition-colors"
      >
        <Bell className="w-4 h-4" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">
            {count}
          </span>
        )}
      </button>

      {open && (
        <Dialog title="Notifications" onClose={() => setOpen(false)}>
          <div className="space-y-2">
            {items.length === 0 && (
              <p className="text-sm text-zinc-500 py-4 text-center">
                No notifications.
              </p>
            )}
            {items.map((n) => {
              const key = notificationKey(n);
              return (
                <div
                  key={key}
                  className="flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-200 truncate">
                      {n.kind === "channel_invite"
                        ? "Channel invite"
                        : "Workspace invite"}{" "}
                      · {label(n)}
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      Role {n.role}
                      {n.invited_by ? ` · from ${n.invited_by}` : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    loading={busy === key}
                    onClick={() => void act(n, true)}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === key}
                    onClick={() => void act(n, false)}
                  >
                    Decline
                  </Button>
                </div>
              );
            })}
          </div>
        </Dialog>
      )}
    </>
  );
}
