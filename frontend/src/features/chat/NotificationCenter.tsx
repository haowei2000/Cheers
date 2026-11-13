import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { UnreadBadge } from "@/components/ui/unread-badge";
import { useNotificationStore } from "@/stores/notificationStore";
import { useActivityUiStore } from "@/stores/activityUiStore";
import { getFleetBadge } from "@/api/fleet";
import { ActivityInbox } from "@/features/activity/ActivityInbox";

/** The rail owns its badge; inbox content and actions are shared with /activity. */
export function ActivityCenter() {
  const navigate = useNavigate();
  const open = useActivityUiStore(state => state.open);
  const setOpen = useActivityUiStore(state => state.setOpen);
  const [approvalCount, setApprovalCount] = useState(0);
  const inviteCount = useNotificationStore(state => state.items.length);
  const refreshBadge = useCallback(async () => {
    try { const value = await getFleetBadge(); setApprovalCount(value.count); }
    catch { /* The inbox exposes load failures; retain the last known badge. */ }
  }, []);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const value = await getFleetBadge(); if (alive) setApprovalCount(value.count); }
      catch { /* Retain the badge during transient polling failures. */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    window.addEventListener("focus", load);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", load); };
  }, []);
  const badge = inviteCount + approvalCount;
  return <>
    <IconButton onClick={() => navigate("/activity")} label="Activity — approvals & invites" className="relative text-content-primary">
      <Bell className="h-4 w-4" />
      {badge > 0 && <UnreadBadge contentSize="small" tone={approvalCount > 0 ? "approval" : "unread"} className="absolute -right-0.5 -top-0.5" title={`${badge} pending activities`} aria-label={`${badge} pending activities`}>{badge}</UnreadBadge>}
    </IconButton>
    {open && <Dialog title="Activity" onClose={() => setOpen(false)}><ActivityInbox onResolved={() => void refreshBadge()} /></Dialog>}
  </>;
}
/** @deprecated Use ActivityCenter. */
export const NotificationCenter = ActivityCenter;
