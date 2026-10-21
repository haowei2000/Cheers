import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { resolveTaskClaim } from "@/api/taskClaims";
import { Button } from "@/components/ui/button";
import { controlIconClasses } from "@/components/ui/control-size";
import { clientSessionGeneration } from "@/lib/clientSession";
import type { Message } from "@/types";
import { claimConfirmationUpdate } from "./taskClaimProjection";

type Decision = "accept" | "reject";

/** The existing message footer, also rendered in the component gallery. */
export function TaskClaimConfirmationFooter({ data, actionable, busy = false, error, onResolve }: {
  data: Record<string, unknown>;
  actionable: boolean;
  busy?: boolean;
  error?: string | null;
  onResolve: (decision: Decision) => void;
}) {
  const status = data.claim_status;
  const resolved = data.resolved === true || (typeof status === "string" && status !== "pending");
  const note = typeof data.resolution_note === "string" ? data.resolution_note : "";
  const label = status === "executing" ? "Task claim accepted" :
    status === "completed" ? "Task completed" :
    status === "rejected" ? "Task claim rejected" :
    status === "cancelled" ? "Task claim cancelled" :
    status === "failed" ? (/expir/i.test(note) ? "Task claim expired" : "Task claim failed") :
    "Claim response recorded";
  // MessageItem owns the message chrome; this is only its action/status footer.
  if (resolved) return <p role="status" className="mt-2 text-compact text-content-muted">{label}</p>;
  if (!actionable) return null;
  return <div className="mt-3 space-y-2" aria-busy={busy}>
    <div className="flex items-center gap-2">
      <Button action="decline" content="iconText" controlSize="compact" variant="secondary" disabled={busy} onClick={() => onResolve("reject")}>
        <X className={controlIconClasses.compact} />
      </Button>
      <Button action="accept" content="iconText" controlSize="compact" loading={busy} disabled={busy} aria-label="Accept claim" onClick={() => onResolve("accept")}>
        <Check className={controlIconClasses.compact} />
      </Button>
    </div>
    {error && <p role="alert" className="text-compact text-danger-400">{error}</p>}
  </div>;
}

export function TaskClaimConfirmationCard({ message, channelId, currentUserId, onContentDataUpdated }: {
  message: Message;
  channelId?: string;
  currentUserId?: string;
  onContentDataUpdated?: (msgId: string, data: Message["content_data"]) => void;
}) {
  const data = (message.content_data ?? {}) as Record<string, unknown>;
  const claimId = typeof data.claim_id === "string" ? data.claim_id : "";
  const requesterId = typeof data.requester_id === "string" ? data.requester_id : "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = `${channelId}:${message.msg_id}:${claimId}:${currentUserId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mountedRef = useRef(false);
  const requestRef = useRef(false);
  const requestIdRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { requestIdRef.current++; setBusy(false); setError(null); requestRef.current = false; }, [scope]);
  const actionable = !!channelId && !!claimId && currentUserId === requesterId &&
    data.resolved !== true && (!data.claim_status || data.claim_status === "pending");
  const resolve = async (decision: Decision) => {
    if (!channelId || !claimId || !actionable || requestRef.current) return;
    requestRef.current = true;
    setBusy(true);
    setError(null);
    const requestId = ++requestIdRef.current;
    const generation = clientSessionGeneration();
    const current = () => mountedRef.current && scopeRef.current === scope && requestIdRef.current === requestId && clientSessionGeneration() === generation;
    try {
      const update = await resolveTaskClaim(channelId, claimId, decision);
      if (!current()) return;
      const confirmation = claimConfirmationUpdate(update, channelId);
      if (update.channel_id !== channelId || update.claim_id !== claimId ||
        !confirmation || confirmation.msg_id !== message.msg_id) throw new Error("Could not refresh this task claim. Try again.");
      onContentDataUpdated?.(confirmation.msg_id, confirmation.content_data);
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : "Could not resolve task claim. Try again.");
    } finally {
      if (current()) { requestRef.current = false; setBusy(false); }
    }
  };
  return <TaskClaimConfirmationFooter data={data} actionable={actionable} busy={busy} error={error} onResolve={(decision) => void resolve(decision)} />;
}
