import { useCallback, useEffect, useState } from "react";
import { Bot, Check, X } from "lucide-react";
import toast from "react-hot-toast";
import {
  cancelTaskClaim,
  listTaskClaims,
  resolveTaskClaim,
  type TaskClaim,
} from "@/api/taskClaims";
import { Button } from "@/components/ui/button";
import { ItemSection, OperationsItem } from "@/components/ui/item";

export function TaskClaimsPanel({
  channelId,
  canManage,
  refreshKey = 0,
}: {
  channelId: string;
  canManage: boolean;
  refreshKey?: number;
}) {
  const [claims, setClaims] = useState<TaskClaim[]>([]);
  const [busy, setBusy] = useState("");
  const refresh = useCallback(
    () => listTaskClaims(channelId, "pending").then(setClaims).catch(() => {}),
    [channelId],
  );
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  if (!claims.length) return null;

  const resolve = async (c: TaskClaim, decision: "accept" | "reject") => {
    setBusy(c.claim_id);
    try {
      await resolveTaskClaim(channelId, c.claim_id, decision);
      setClaims((v) => v.filter((x) => x.claim_id !== c.claim_id));
      toast.success(
        decision === "accept"
          ? `${c.bot_name} started the task`
          : "Claim rejected",
      );
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not resolve claim",
      );
      await refresh();
    } finally {
      setBusy("");
    }
  };

  const cancel = async (c: TaskClaim) => {
    setBusy(c.claim_id);
    try {
      await cancelTaskClaim(channelId, c.claim_id);
      setClaims((v) => v.filter((x) => x.claim_id !== c.claim_id));
      toast.success("Claim cancelled");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not cancel claim",
      );
    } finally {
      setBusy("");
    }
  };

  return (
    <ItemSection
      label="Task claim requests"
      action={<span className="font-normal tabular-nums text-zinc-500">{claims.length}</span>}
      presentationLevel="max"
      controlSize="regular"
      className="mx-4 mb-2 max-h-72 overflow-y-auto"
    >
      {claims.map((c) => (
        <OperationsItem
          key={c.claim_id}
          leading={<Bot className="h-4 w-4 text-indigo-400" />}
          title={`${c.bot_name} wants to claim a task`}
          subtitle={c.summary}
          preview={c.proposed_action}
          metadata={`${Math.round(c.confidence * 100)}% confidence · ${c.impact} impact`}
          actions={canManage ? <>
                <Button
                  controlSize="compact"
                  variant="secondary"
                  disabled={busy === c.claim_id}
                  onClick={() => void cancel(c)}
                >
                  <X className="h-3.5 w-3.5" />
                  Cancel
                </Button>
                <Button
                  controlSize="compact"
                  variant="secondary"
                  disabled={busy === c.claim_id}
                  onClick={() => void resolve(c, "reject")}
                >
                  <X className="h-3.5 w-3.5" />
                  Reject
                </Button>
                <Button
                  controlSize="compact"
                  loading={busy === c.claim_id}
                  onClick={() => void resolve(c, "accept")}
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve &amp; run
                </Button>
              </> : undefined}
        />
      ))}
    </ItemSection>
  );
}
