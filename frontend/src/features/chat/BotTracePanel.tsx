import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Wrench,
  ListTodo,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { fetchMessageTrace, type TraceEntry } from "@/api/approval";

interface Props {
  channelId: string;
  msgId: string;
}

/** Icon + tone + short label for a persisted trace row. Approval rows get the
 *  shield/check/x family; agent-progress rows map by phase. */
function eventMeta(e: TraceEntry): { Icon: LucideIcon; tone: string; label: string } {
  if (e.kind === "approval") {
    const ak = e.approval_kind ?? "";
    if (ak === "resolved") {
      const ok = (e.decision ?? "").startsWith("allow");
      return ok
        ? { Icon: CheckCircle2, tone: "text-emerald-400", label: "Approved" }
        : { Icon: XCircle, tone: "text-rose-400", label: "Denied" };
    }
    if (ak === "expired" || ak === "rejected") {
      return { Icon: XCircle, tone: "text-zinc-500", label: ak === "expired" ? "Expired" : "Rejected" };
    }
    if (ak === "auto_allowed") {
      return { Icon: CheckCircle2, tone: "text-emerald-400/80", label: "Auto-allowed" };
    }
    return { Icon: ShieldCheck, tone: "text-amber-400", label: "Approval" };
  }
  switch (e.phase) {
    case "tool_call":
    case "tool_call_update":
      return { Icon: Wrench, tone: "text-orange-400", label: "Tool" };
    case "plan":
      return { Icon: ListTodo, tone: "text-sky-400", label: "Plan" };
    case "prompt_finished":
      return { Icon: CheckCircle2, tone: "text-emerald-400", label: "Done" };
    case "prompt_started":
      return { Icon: Zap, tone: "text-zinc-400", label: "Start" };
    case "prompt_failed":
    case "terminal_ack_failed":
      return { Icon: XCircle, tone: "text-rose-400", label: "Failed" };
    default:
      return { Icon: Clock, tone: "text-zinc-500", label: e.phase || "Event" };
  }
}

/**
 * Collapsible "agent steps" panel for a completed bot turn. Lazily fetches the
 * durable trace timeline (docs/arch/TRACE_PERSISTENCE.md) on first expand and
 * renders each persisted step — including approval events interleaved inline.
 * Self-hides when a turn has no recorded steps.
 */
export function BotTracePanel({ channelId, msgId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<TraceEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMessageTrace(channelId, msgId);
      setEvents(res.events ?? []);
    } catch (e) {
      // Leave events === null so the next expand retries.
      setError(e instanceof Error ? e.message : "Failed to load trace");
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && events === null && !loading) void load();
  }

  // Once we've loaded and found nothing, drop the toggle entirely (no noise).
  if (events !== null && events.length === 0 && !expanded) return null;

  return (
    <div className="mt-1 max-w-md">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <span>Agent steps{events ? ` · ${events.length}` : ""}</span>
        {loading && <Loader2 className="w-3 h-3 animate-spin" />}
      </button>

      {expanded && events && events.length > 0 && (
        <div className="mt-1 rounded-md border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800/70 overflow-hidden">
          {events.map((e) => {
            const { Icon, tone, label } = eventMeta(e);
            const isApproval = e.kind === "approval";
            return (
              <div key={e.id} className="flex items-start gap-2 px-2.5 py-1.5">
                <Icon className={cn("w-3.5 h-3.5 mt-0.5 shrink-0", tone)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "text-xs truncate",
                        isApproval ? "text-zinc-200 font-medium" : "text-zinc-300"
                      )}
                    >
                      {e.title || label}
                    </span>
                    <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">
                      {label}
                      {e.status ? ` · ${e.status}` : ""}
                    </span>
                  </div>
                  {isApproval && e.decision && (
                    <div className="text-[11px] text-zinc-500">
                      {e.decision}
                      {e.actor_id ? ` · ${e.actor_id.slice(0, 8)}` : ""}
                    </div>
                  )}
                  {!isApproval && e.message && (
                    <div className="text-[11px] text-zinc-500 truncate">
                      {e.message}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {expanded && events && events.length === 0 && !loading && !error && (
        <div className="mt-1 px-2.5 text-[11px] text-zinc-600">
          No steps recorded.
        </div>
      )}

      {expanded && error && !loading && (
        <div className="mt-1 px-2.5 flex items-center gap-2 text-[11px] text-rose-400">
          <span>Failed to load steps.</span>
          <button
            type="button"
            onClick={() => void load()}
            className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
