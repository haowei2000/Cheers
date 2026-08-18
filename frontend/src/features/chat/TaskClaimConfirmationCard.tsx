import { useState } from "react";
import { Check, X } from "lucide-react";
import toast from "react-hot-toast";
import { resolveTaskClaim } from "@/api/taskClaims";
import { Button } from "@/components/ui/button";
import type { Message } from "@/types";

export function TaskClaimConfirmationCard({ message, channelId, currentUserId }: { message: Message; channelId?: string; currentUserId?: string }) {
  const data = (message.content_data ?? {}) as Record<string, unknown>;
  const claimId = typeof data.claim_id === "string" ? data.claim_id : "";
  const requesterId = typeof data.requester_id === "string" ? data.requester_id : "";
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(data.resolved === true);
  const actionable = !!channelId && !!claimId && currentUserId === requesterId && !resolved;
  const resolve = async (decision: "accept" | "reject") => {
    if (!channelId || !claimId) return;
    setBusy(true);
    try {
      await resolveTaskClaim(channelId, claimId, decision);
      setResolved(true);
      toast.success(decision === "accept" ? "Task claim confirmed" : "Task claim rejected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not resolve task claim");
    } finally { setBusy(false); }
  };
  // This deliberately contains no message chrome. The enclosing MessageItem
  // renders the avatar, sender header, reply quote and text exactly like any
  // other bot reply; this is only the small action footer attached to it.
  if (resolved) {
    return <p className="mt-2 text-compact text-content-muted">Claim response recorded</p>;
  }
  if (!actionable) return null;
  return <div className="mt-3 flex items-center gap-2">
    <Button action="decline" content="iconText" controlSize="compact" variant="secondary" disabled={busy} onClick={() => void resolve("reject")}>
      <X className="h-3.5 w-3.5" />
    </Button>
    <Button action="accept" content="iconText" controlSize="compact" loading={busy} aria-label="Accept claim" onClick={() => void resolve("accept")}>
      <Check className="h-3.5 w-3.5" />
    </Button>
  </div>;
}
