import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Bell, History, RefreshCw, Shield } from "lucide-react";
import toast from "react-hot-toast";
import { getAllFleet, getFleetAudit, type FleetApproval, type FleetAuditEvent } from "@/api/fleet";
import { acceptNotification, declineNotification, notificationKey, type NotificationItem } from "@/api/notifications";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ItemSection, OperationsItem } from "@/components/ui/item";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { PermissionCard } from "@/features/chat/PermissionCard";
import { useAuthStore } from "@/stores/authStore";
import { useNotificationStore } from "@/stores/notificationStore";
import type { Message } from "@/types";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";

function approvalMessage(approval: FleetApproval): Message {
  return {
    msg_id: approval.message_id,
    sender_id: approval.bot_id,
    sender_type: "bot",
    content: "",
    created_at: approval.created_at,
    msg_type: "permission",
    content_data: approval.content_data,
  };
}

function inviteTitle(item: NotificationItem) {
  const kind = item.kind === "friend_request" ? "Friend request"
    : item.kind === "workspace_invite" ? "Workspace invite"
      : item.kind === "bot_channel_invite" ? "Bot approval" : "Channel invite";
  return `${kind} · ${item.title}${item.actor_name ? ` · from ${item.actor_name}` : ""}`;
}

export default function ActivityPage() {
  const navigate = useNavigate();
  const userId = useAuthStore((state) => state.user?.user_id);
  const invites = useNotificationStore((state) => state.items);
  const refreshInvites = useNotificationStore((state) => state.refresh);
  const removeInvite = useNotificationStore((state) => state.remove);
  const [approvals, setApprovals] = useState<FleetApproval[]>([]);
  const [recent, setRecent] = useState<FleetAuditEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [fleet, audit] = await Promise.all([
        getAllFleet(),
        getFleetAudit({ limit: 30 }).catch(() => ({ events: [] })),
        refreshInvites(),
      ]);
      setApprovals(fleet.approvals.filter((approval) => approval.actionable));
      setRecent(audit.events.filter((event) => event.source === "approval").slice(0, 10));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't load activity");
    } finally {
      setLoading(false);
      if (!quiet) setRefreshing(false);
    }
  }, [refreshInvites]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function act(item: NotificationItem, accept: boolean) {
    const key = notificationKey(item);
    setBusy(key);
    try {
      if (accept) await acceptNotification(item); else await declineNotification(item);
      removeInvite(item);
      toast.success(accept ? "Accepted" : "Declined");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Operation failed");
    } finally {
      setBusy(null);
    }
  }

  const headerActions = <IconButton label="Refresh activity" disabled={refreshing} onClick={() => void refresh()}>
    <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
  </IconButton>;

  return <div className="flex h-full flex-col bg-zinc-950 text-content-primary">
    <RouteChromeHeader actions={headerActions}>
      <header className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <IconButton label="Back to chat" onClick={() => navigate("/chat")}><ArrowLeft className="h-4 w-4" aria-hidden="true" /></IconButton>
        <Bell className="h-4 w-4 text-accent-400" aria-hidden="true" />
        <h1 className="text-comfortable font-semibold">Activity</h1>
        <div className="ml-auto">{headerActions}</div>
      </header>
    </RouteChromeHeader>
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-7 px-4 py-6">
        {loading ? <SurfaceSpinner /> : approvals.length === 0 && invites.length === 0 && recent.length === 0 ?
          <EmptyState icon={Bell} title="Nothing waiting" hint="Approvals and invitations across all workspaces appear here." /> : <>
          {approvals.length > 0 && <ItemSection label={<span className="flex items-center gap-2"><Shield className="h-3.5 w-3.5 text-warning-400" />Needs approval</span>} presentationLevel="medium" controlSize="regular">
            {approvals.map((approval) => <div role="listitem" key={approval.message_id} className="space-y-1 py-1">
              <p className="px-2 text-minimal uppercase tracking-label text-content-muted">{approval.channel_name ? `#${approval.channel_name}` : "Direct message"}</p>
              <PermissionCard message={approvalMessage(approval)} channelId={approval.channel_id} currentUserId={userId} approverOverride onResolved={() => setApprovals((items) => items.filter((item) => item.message_id !== approval.message_id))} />
            </div>)}
          </ItemSection>}
          {invites.length > 0 && <ItemSection label="Invitations" presentationLevel="medium" controlSize="regular">
            {invites.map((item) => {
              const key = notificationKey(item);
              return <OperationsItem key={key} title={inviteTitle(item)} subtitle={item.role ? `Role ${item.role}` : "Response required"} actions={<>
                <Button action="accept" controlSize="compact" loading={busy === key} onClick={() => void act(item, true)}>Accept</Button>
                <Button action="decline" variant="ghost" controlSize="compact" disabled={busy === key} onClick={() => void act(item, false)}>Decline</Button>
              </>} />;
            })}
          </ItemSection>}
          {recent.length > 0 && <ItemSection label={<span className="flex items-center gap-2"><History className="h-3.5 w-3.5" />Recent</span>} presentationLevel="medium" controlSize="regular">
            {recent.map((event) => <OperationsItem key={`${event.source}:${event.id}`} title={event.event_type.replaceAll("_", " ")} subtitle={new Date(event.created_at).toLocaleString()} status={<span className="text-compact text-content-muted">Resolved</span>} />)}
          </ItemSection>}
        </>}
      </div>
    </main>
  </div>;
}
