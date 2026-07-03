import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  listMyInvites,
  acceptInvite,
  declineInvite,
  type WorkspaceInvite,
} from "@/api/workspaces";

// Lists the caller's pending workspace invites with accept/decline. `onChanged`
// fires after any accept/decline so the rail can refetch workspaces + invite count.
export function WorkspaceInvitesDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    listMyInvites()
      .then(setInvites)
      .catch(() => setInvites([]));
  }, []);

  async function act(inv: WorkspaceInvite, accept: boolean) {
    setBusy(inv.workspace_id);
    try {
      if (accept) await acceptInvite(inv.workspace_id);
      else await declineInvite(inv.workspace_id);
      setInvites((prev) => prev.filter((i) => i.workspace_id !== inv.workspace_id));
      toast.success(accept ? `Joined ${inv.name}` : "Declined");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog title="Workspace invites" onClose={onClose}>
      <div className="space-y-2">
        {invites.length === 0 && (
          <p className="text-sm text-zinc-500 py-4 text-center">No pending invites.</p>
        )}
        {invites.map((inv) => (
          <div
            key={inv.workspace_id}
            className="flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-200 truncate">{inv.name}</p>
              <p className="text-[11px] text-zinc-500">
                Role {inv.role}
                {inv.invited_by ? ` · from ${inv.invited_by}` : ""}
              </p>
            </div>
            <Button
              size="sm"
              loading={busy === inv.workspace_id}
              onClick={() => void act(inv, true)}
            >
              Accept
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy === inv.workspace_id}
              onClick={() => void act(inv, false)}
            >
              Decline
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
