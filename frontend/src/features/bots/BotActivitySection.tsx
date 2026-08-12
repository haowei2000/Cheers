import { Button as UiButton } from "@/components/ui/button";
import { useCallback, useEffect, useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import { RefreshCw } from "lucide-react";
import { getBotAcpEvents, type AcpEventRow } from "@/api/bots";
import { ItemList, WorkbenchItem } from "@/components/ui/item";

const homeCls: Record<string, string> = {
  cheers: "bg-indigo-950/60 border-indigo-900 text-indigo-200",
  observe: "bg-zinc-800 border-zinc-700 text-zinc-300",
  connector: "bg-amber-950/50 border-amber-900 text-amber-200",
  agent: "bg-zinc-800 border-zinc-700 text-zinc-400",
};

const shortName = (n: string) =>
  n.replace(/^session\/update:/, "").replace(/^session\//, "");
const time = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
};

/**
 * Read-only ACP event timeline (docs/arch/ACP_EVENT_TAXONOMY.md, Phase 5) — every
 * event the bot emitted, from acp_event_log, tagged by its registry home.
 */
export function BotActivitySection({ botId }: { botId: string }) {
  const [events, setEvents] = useState<AcpEventRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents((await getBotAcpEvents(botId, 80)).events);
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
        <span className="text-xs font-medium text-zinc-300">Recent activity</span>
        <span className="text-[11px] text-zinc-400">
          every event the bot emitted (newest first)
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
        <p className="text-[11px] text-zinc-400">
          {loading ? "Loading…" : "No events recorded yet — prompt the bot to see its activity."}
        </p>
      ) : (
        <ItemList presentationLevel="max" controlSize="regular" className="max-h-56 overflow-y-auto pr-1">
          {events.map((e, i) => (
            <WorkbenchItem key={i} title={<code>{shortName(e.name)}</code>} metadata={time(e.created_at)}
              status={<span
                className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] ${homeCls[e.home] ?? homeCls.observe}`}
                title={`home: ${e.home || "unclassified"}`}
              >
                {e.home || "?"}
              </span>}
              presentationLevel="max" className="border-0 bg-zinc-950/30" />
          ))}
        </ItemList>
      )}
    </div>
  );
}
