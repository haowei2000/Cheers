import { Button as UiButton } from "@/components/ui/button";
import { useCallback, useEffect, useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import { RefreshCw, ArrowUpCircle, ArrowDownCircle } from "lucide-react";
import { listBotConnectionEvents, type BotConnectionEvent } from "@/api/bots";
import { ItemList, WorkbenchItem } from "@/components/ui/item";

const reasonLabel: Record<string, string> = {
  closed: "connection closed",
  superseded: "replaced by a new connection",
  idle_timeout: "heartbeat lost (90s idle)",
  protocol_error: "protocol error",
  write_failed: "write failed",
  unbound: "unbound by server",
};

const time = (iso: string) => {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

/**
 * Bridge connect/disconnect timeline (bot_connection_events) — the persisted
 * history behind the live online dot, including why a connector went away.
 */
export function BotConnectionHistorySection({ botId }: { botId: string }) {
  const [events, setEvents] = useState<BotConnectionEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await listBotConnectionEvents(botId, 50));
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="rounded-sm bg-zinc-950/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-compact font-medium text-zinc-300">Connection history</span>
        <span className="text-compact text-zinc-400">
          bridge connects/disconnects (newest first)
        </span>
        <UiButton variant="plain"
          type="button"
          onClick={load}
          className="ml-auto text-zinc-500 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </UiButton>
      </div>
      {events.length === 0 ? (
        <p className="text-compact text-zinc-400">
          {loading ? "Loading…" : "No connections recorded yet — attach a connector to see its history."}
        </p>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular" className="max-h-56 overflow-y-auto pr-1">
          {events.map((e, i) => (
            <WorkbenchItem key={i} title={`${e.event}${e.reason ? ` · ${reasonLabel[e.reason] ?? e.reason}` : ""}`}
              trailing={<span className="text-compact tabular-nums text-zinc-400">{time(e.created_at)}</span>} leading={e.event === "connected" ? (
                <ArrowUpCircle className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
              ) : (
                <ArrowDownCircle className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
              )} status={<span className="shrink-0 rounded-sm px-2 py-1 text-minimal bg-zinc-800 text-zinc-400">
                {e.stream}
              </span>} presentationLevel="medium" className="border-0 bg-zinc-950/30" />
          ))}
        </ItemList>
      )}
    </div>
  );
}
