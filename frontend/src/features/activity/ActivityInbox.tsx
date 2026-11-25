import { SettingsSection } from "@/components/ui/settings-card";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, History, RefreshCw, Shield } from "lucide-react";
import toast from "react-hot-toast";
import { getAllFleet, getFleetAudit, type FleetApproval, type FleetAuditEvent } from "@/api/fleet";
import { acceptNotification, declineNotification, notificationKey, type NotificationItem } from "@/api/notifications";
import { listWorkspaces } from "@/api/workspaces";
import { listChannels, listDms } from "@/api/channels";
import { AsyncContent } from "@/components/ui/async-content";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Banner } from "@/components/ui/banner";
import { ItemSection, OperationsItem } from "@/components/ui/item";
import { PermissionCard } from "@/features/chat/PermissionCard";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { useNotificationStore } from "@/stores/notificationStore";
import type { Message } from "@/types";

/** Refresh membership after accepting an invitation in either Activity surface. */
async function refreshMembership() {
  const store = useChatStore.getState();
  store.setWorkspaces(await listWorkspaces());
  if (!store.selectedWorkspaceId) return;
  const personal = store.personalWorkspace?.workspace_id === store.selectedWorkspaceId;
  const [channels, dms] = await Promise.all([
    listChannels(store.selectedWorkspaceId), personal ? listDms() : Promise.resolve([]),
  ]);
  store.setChannels([...channels, ...dms]);
}

function approvalMessage(approval: FleetApproval): Message {
  return { msg_id: approval.message_id, sender_id: approval.bot_id, sender_type: "bot", content: "", created_at: approval.created_at, msg_type: "permission", content_data: approval.content_data };
}

function inviteTitle(item: NotificationItem) {
  const kind = item.kind === "friend_request" ? "Friend request" : item.kind === "workspace_invite" ? "Workspace invite" : item.kind === "bot_channel_invite" ? "Bot approval" : "Channel invite";
  const title = item.kind === "channel_invite" || item.kind === "bot_channel_invite" ? `#${item.title}` : item.title;
  return `${kind} · ${title}${item.actor_name ? ` · from ${item.actor_name}` : ""}`;
}

/** The page and dialog use the same data lifecycle, rows, and invitation actions. */
export function ActivityInbox({ onResolved }: { onResolved?: () => void }) {
  const userId = useAuthStore(state => state.user?.user_id);
  const invites = useNotificationStore(state => state.items);
  const [approvals, setApprovals] = useState<FleetApproval[]>([]);
  const [recent, setRecent] = useState<FleetAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setRefreshing(true);
    const results = await Promise.allSettled([
      getAllFleet(), getFleetAudit({ limit: 30 }), useNotificationStore.getState().refresh(),
    ]);
    if (id !== request.current) return;
    const [fleet, audit] = results;
    if (fleet.status === "fulfilled") setApprovals(fleet.value.approvals.filter(item => item.actionable));
    if (audit.status === "fulfilled") setRecent(audit.value.events.filter(item => item.source === "approval").slice(0, 10));
    const failed = results.find(result => result.status === "rejected");
    const notificationError = useNotificationStore.getState().error;
    setError(failed?.status === "rejected" ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : notificationError);
    setLoading(false);
    setRefreshing(false);
  }, []);
  useEffect(() => {
    const counter = request;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { ++counter.current; window.clearInterval(timer); };
  }, [refresh]);

  async function act(item: NotificationItem, accept: boolean) {
    if (busy) return;
    setBusy(notificationKey(item));
    setActionError(null);
    try {
      if (accept) await acceptNotification(item); else await declineNotification(item);
      useNotificationStore.getState().remove(item);
      toast.success(accept ? "Accepted" : "Declined");
      if (accept) {
        try { await refreshMembership(); }
        catch { setActionError("Invitation accepted. Refresh the workspace list to see your updated memberships."); }
      }
      onResolved?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Couldn't respond to this invitation");
    } finally { setBusy(null); }
  }

  return <SettingsSection title="Inbox" icon={Bell} actions={
      <IconButton label="Refresh activity" disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /></IconButton>
    }>
    {actionError && <Banner severity="error">{actionError}</Banner>}
    <AsyncContent loading={loading} error={error} onRetry={() => void refresh()}>
      {!approvals.length && !invites.length && !recent.length && <EmptyState icon={Bell} title="Nothing waiting" hint="Approvals and invitations across all workspaces appear here." />}
      {approvals.length > 0 && <ItemSection label={<span className="flex items-center gap-2"><Shield className="h-4 w-4" />Needs approval</span>} presentationLevel="medium" controlSize="regular">
        {approvals.map(approval => <div role="listitem" key={approval.message_id} className="space-y-1 py-1">
          <p className="px-2 text-compact text-content-muted">{approval.channel_name || "Direct message"}</p>
          <PermissionCard message={approvalMessage(approval)} channelId={approval.channel_id} currentUserId={userId} approverOverride onResolved={() => {
            setApprovals(items => items.filter(item => item.message_id !== approval.message_id)); onResolved?.();
          }} />
        </div>)}
      </ItemSection>}
      {invites.length > 0 && <ItemSection label="Invitations" presentationLevel="medium" controlSize="regular">
        {invites.map(item => <OperationsItem key={notificationKey(item)} title={inviteTitle(item)} status={<span className="max-w-36 truncate text-compact text-content-muted" title={[item.role, item.bot_name, item.requested_cwd].filter(Boolean).join(" · ")}>{item.role ? `Role ${item.role}` : "Response required"}</span>} actions={<>
          <Button action="accept" controlSize="compact" loading={busy === notificationKey(item)} disabled={busy !== null} onClick={() => void act(item, true)} />
          <Button action="decline" variant="ghost" controlSize="compact" disabled={busy !== null} onClick={() => void act(item, false)} />
        </>} />)}
      </ItemSection>}
      {recent.length > 0 && <ItemSection label={<span className="flex items-center gap-2"><History className="h-4 w-4" />Recent</span>} presentationLevel="medium" controlSize="regular">
        {recent.map(event => <OperationsItem key={`${event.source}:${event.id}`} title={event.event_type.replaceAll("_", " ")} status={<span className="text-compact text-content-muted" title={new Date(event.created_at).toLocaleString()}>Resolved</span>} />)}
      </ItemSection>}
    </AsyncContent>
  </SettingsSection>;
}
