import { useEffect, useState } from "react";
import { Bell, Shield } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ItemSection, OperationsItem } from "@/components/ui/item";
import toast from "react-hot-toast";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { UnreadBadge } from "@/components/ui/unread-badge";
import { useNotificationStore } from "@/stores/notificationStore";
import { useActivityUiStore } from "@/stores/activityUiStore";
import { useChatStore } from "@/stores/chatStore";
import { useAuthStore } from "@/stores/authStore";
import { listWorkspaces } from "@/api/workspaces";
import { listChannels, listDms } from "@/api/channels";
import {
  acceptNotification,
  declineNotification,
  notificationKey,
  type NotificationItem,
} from "@/api/notifications";
import { getFleet, getFleetBadge, type FleetApproval } from "@/api/fleet";
import { PermissionCard } from "@/features/chat/PermissionCard";
import type { Message } from "@/types";

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
  return n.kind === "channel_invite" || n.kind === "bot_channel_invite"
    ? `#${n.title}`
    : n.title;
}

function kindLabel(n: NotificationItem): string {
  switch (n.kind) {
    case "friend_request":
      return "Friend request";
    case "channel_invite":
      return "Channel invite";
    case "bot_channel_invite":
      return "Bot approval";
    default:
      return "Workspace invite";
  }
}

function toCardMessage(a: FleetApproval, botName?: string): Message {
  return {
    msg_id: a.message_id,
    sender_id: a.bot_id,
    sender_type: "bot",
    sender_name: botName,
    content: "",
    created_at: a.created_at,
    msg_type: "permission",
    content_data: a.content_data,
  };
}

function workspaceIdsFromStore(): string[] {
  const { workspaces, personalWorkspace } = useChatStore.getState();
  const ids = workspaces.map((w) => w.workspace_id);
  if (
    personalWorkspace &&
    !ids.includes(personalWorkspace.workspace_id)
  ) {
    ids.unshift(personalWorkspace.workspace_id);
  }
  return [...new Set(ids)];
}

/** Activity rail control — approvals + invites (`docs/arch/CLIENT_NAV_IA.md`). */
export function ActivityCenter() {
  const open = useActivityUiStore((s) => s.open);
  const setOpen = useActivityUiStore((s) => s.setOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<FleetApproval[]>([]);
  const [approvalCount, setApprovalCount] = useState(0);
  const items = useNotificationStore((s) => s.items);
  const remove = useNotificationStore((s) => s.remove);
  const workspaces = useChatStore((s) => s.workspaces);
  const personalWorkspace = useChatStore((s) => s.personalWorkspace);
  const user = useAuthStore((s) => s.user);
  const inviteCount = items.length;
  const badge = inviteCount + approvalCount;

  const refreshBadge = () =>
    getFleetBadge()
      .then((r) => setApprovalCount(r.count))
      .catch(() => {});

  function approvalResolved(messageId: string) {
    setApprovals((current) => current.filter((a) => a.message_id !== messageId));
    setApprovalCount((current) => Math.max(0, current - 1));
    void refreshBadge();
  }

  useEffect(() => {
    let alive = true;
    const loadBadge = () =>
      getFleetBadge()
        .then((r) => alive && setApprovalCount(r.count))
        .catch(() => {});
    loadBadge();
    const t = window.setInterval(loadBadge, 60_000);
    window.addEventListener("focus", loadBadge);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener("focus", loadBadge);
    };
  }, []);

  // Load actionable approvals across every workspace the caller can see —
  // the badge is global (`/fleet/badge`), so the dialog must match.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const ids = workspaceIdsFromStore();
    if (ids.length === 0) {
      setApprovals([]);
      return;
    }
    void Promise.all(
      ids.map((id) =>
        getFleet(id).catch(() => ({ approvals: [] as FleetApproval[], bots: [] }))
      )
    ).then((results) => {
      if (!alive) return;
      const seen = new Set<string>();
      const merged: FleetApproval[] = [];
      for (const res of results) {
        for (const a of res.approvals) {
          if (!a.actionable || seen.has(a.message_id)) continue;
          seen.add(a.message_id);
          merged.push(a);
        }
      }
      setApprovals(merged);
      // Keep the rail badge on the global count — never overwrite it with a
      // per-workspace slice.
      void refreshBadge();
    });
    return () => {
      alive = false;
    };
  }, [open, workspaces, personalWorkspace]);

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

  const empty = approvals.length === 0 && items.length === 0;

  return (
    <>
      <IconButton
        onClick={() => setOpen(true)}
        label="Activity — approvals & invites"
        className="relative text-zinc-500"
      >
        <Bell className="w-4 h-4" />
        {badge > 0 && (
          <UnreadBadge
            contentSize="small"
            tone={approvalCount > 0 ? "approval" : "unread"}
            className="absolute -right-0.5 -top-0.5"
            title={`${badge} pending activities`}
            aria-label={`${badge} pending activities`}
          >
            {badge}
          </UnreadBadge>
        )}
      </IconButton>

      {open && (
        <Dialog title="Activity" onClose={() => setOpen(false)}>
          <div className="space-y-5">
            {empty && (
              <EmptyState
                icon={Bell}
                title="Nothing waiting"
                hint="Approvals, friend requests, and invitations appear here."
              />
            )}

            {approvals.length > 0 && (
              <ItemSection
                presentationLevel="medium"
                controlSize="regular"
                label={<span className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-amber-400" />
                  Needs approval
                </span>}
              >
                  {approvals.map((a) => (
                    <div role="listitem" key={a.message_id} className="space-y-1 py-1">
                      <p className="text-minimal uppercase tracking-wide text-zinc-400 mb-1">
                        {a.channel_name.trim() ? `#${a.channel_name}` : "Direct message"}
                      </p>
                      <PermissionCard
                        message={toCardMessage(a)}
                        channelId={a.channel_id}
                        currentUserId={user?.user_id}
                        approverOverride
                        onResolved={() => approvalResolved(a.message_id)}
                      />
                    </div>
                  ))}
              </ItemSection>
            )}

            {items.length > 0 && (
              <ItemSection label="Invites" presentationLevel="medium" controlSize="regular">
                {items.map((n) => {
                  const key = notificationKey(n);
                  return (
                    <OperationsItem
                      key={key}
                      title={`${kindLabel(n)} · ${label(n)}${n.actor_name ? ` · from ${n.actor_name}` : ""}`}
                      status={<span className="max-w-36 truncate text-compact text-zinc-400" title={[n.role ? `Role ${n.role}` : "Needs your response", n.bot_name, n.requested_cwd].filter(Boolean).join(" · ")}>
                        {n.role ? `Role ${n.role}` : "Response required"}
                      </span>}
                      actions={<><Button action="accept"
                        controlSize="compact"
                        loading={busy === key}
                        onClick={() => void act(n, true)}
                      >
                        Accept
                      </Button>
                      <Button action="decline"
                        variant="ghost"
                        controlSize="compact"
                        disabled={busy === key}
                        onClick={() => void act(n, false)}
                      >
                        Decline
                      </Button>
                      </>}
                    />
                  );
                })}
              </ItemSection>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

/** @deprecated Use ActivityCenter — kept for any stray imports. */
export const NotificationCenter = ActivityCenter;
