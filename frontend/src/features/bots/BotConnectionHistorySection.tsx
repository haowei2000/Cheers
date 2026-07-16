import { useCallback, useEffect, useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import { RefreshCw, ArrowUpCircle, ArrowDownCircle } from "lucide-react";
import { listBotConnectionEvents, type BotConnectionEvent } from "@/api/bots";

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
    <div className="rounded-xl bg-zinc-950/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-zinc-300">Connection history</span>
        <span className="text-[11px] text-zinc-400">
          bridge connects/disconnects (newest first)
        </span>
        <button
          type="button"
          onClick={load}
          className="ml-auto text-zinc-500 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {events.length === 0 ? (
        <p className="text-[11px] text-zinc-400">
          {loading ? "Loading…" : "No connections recorded yet — attach a connector to see its history."}
        </p>
      ) : (
        <div className="max-h-56 overflow-y-auto divide-y divide-zinc-800/70">
          {events.map((e, i) => (
            <div key={i} className="flex items-center gap-2 py-1 text-[11px]">
              <span className="text-zinc-400 tabular-nums w-36 shrink-0">{time(e.created_at)}</span>
              {e.event === "connected" ? (
                <ArrowUpCircle className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
              ) : (
                <ArrowDownCircle className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
              )}
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-zinc-800 text-zinc-400">
                {e.stream}
              </span>
              <span className={e.event === "connected" ? "text-emerald-300" : "text-zinc-400"}>
                {e.event}
              </span>
              {e.reason && (
                <span className="text-zinc-400 truncate" title={e.reason}>
                  — {reasonLabel[e.reason] ?? e.reason}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
