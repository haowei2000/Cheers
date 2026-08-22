import { useEffect, useState, useCallback } from "react";
import { notify, messageOf } from "@/lib/notify";
import toast from "react-hot-toast";
import { Bot, RefreshCw, Circle, CircleDot, Ban } from "lucide-react";
import {
  listBots,
} from "@/api/bots";
import { ActionButton } from "@/components/ui/action-button";
import { EntityItem } from "@/components/ui/item";
import { CreateBotDialog } from "./CreateBotDialog";
import { CreateHostWizard } from "./CreateHostWizard";
import { BotDetailPanel } from "./BotDetailPanel";
import type { BotItem } from "@/types";
import { avatarSizeClasses } from "@/components/ui/content-size";
import { IconButton } from "@/components/ui/icon-button";

/** One row of the master bot list (left column). */
function BotRow({
  bot,
  active,
  onSelect,
}: {
  bot: BotItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <EntityItem
      onClick={onSelect}
      selected={active}
      title={`${bot.display_name || bot.username} · @${bot.username}`}
      leading={<div className={`flex flex-shrink-0 items-center justify-center rounded-sm bg-indigo-900/50 ${avatarSizeClasses.regular}`}>
        <Bot className="w-4 h-4 text-accent-300" />
      </div>}
      criticalStatus={bot.is_disabled ? (
        <Ban
          className="w-3.5 h-3.5 text-danger-400 flex-shrink-0"
          role="img"
          aria-label="Disabled"
        />
      ) : bot.is_online ? (
        <Circle
          className="w-3.5 h-3.5 flex-shrink-0 fill-emerald-400 text-success-400"
          role="img"
          aria-label="Online"
        />
      ) : (
        <CircleDot
          className="w-3.5 h-3.5 flex-shrink-0 text-content-muted"
          role="img"
          aria-label="Offline"
        />
      )}
      className="border-0"
    />
  );
}

export function BotsManager() {
  const [bots, setBots] = useState<BotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [createBotOpen, setCreateBotOpen] = useState(false);
  const [hostBotId, setHostBotId] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState("");

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const b = await listBots();
      setBots(b);
      setLoadFailed(false);
    } catch (e) {
      // Background polls stay quiet — a transient blip shouldn't toast.
      if (!opts?.silent) {
        setLoadFailed(true);
        notify.error(messageOf(e));
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  // Background "live while open" refetch (item 8): no spinner, no error banner churn.
  const pollRefresh = useCallback(() => {
    void refresh({ silent: true });
  }, [refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep a valid selection: default to the first bot; recover if the selected one vanished.
  useEffect(() => {
    if (bots.length === 0) {
      if (selectedId) setSelectedId("");
      return;
    }
    if (!bots.some((b) => b.bot_id === selectedId)) setSelectedId(bots[0].bot_id);
  }, [bots, selectedId]);

  const selected = bots.find((b) => b.bot_id === selectedId) ?? null;

  return (
    <section>
      <h2 className="text-compact font-semibold text-content-muted uppercase tracking-section mb-4 flex items-center gap-2">
        <Bot className="w-3.5 h-3.5" />
        Bots
        <ActionButton
          action="add"
          context="toolbar"
          accessibleLabel="Add bot"
          controlSize="compact"
          className="ml-auto normal-case tracking-normal"
          onClick={() => {
            setCreateBotOpen(true);
          }}
        />
        <IconButton
          label="Refresh bots"
          onClick={() => void refresh()}
          className="text-content-primary hover:text-content-strong"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </IconButton>
      </h2>

      {bots.length === 0 && !loading ? (
        loadFailed ? (
          <p className="text-regular text-danger-400 px-1">
            Couldn't load bots — check the gateway connection, then press refresh.
          </p>
        ) : (
          <p className="text-regular text-content-muted px-1">
            No bots yet. Click <span className="text-content-secondary">Add bot</span> to create one, then
            connect it to the machine that will run it.
          </p>
        )
      ) : (
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Master: bot list */}
          <div className="sm:w-56 sm:shrink-0 space-y-1">
            {bots.map((bot) => (
              <BotRow
                key={bot.bot_id}
                bot={bot}
                active={bot.bot_id === selectedId}
                onSelect={() => setSelectedId(bot.bot_id)}
              />
            ))}
          </div>

          {/* Detail: selected bot */}
          <div className="flex-1 min-w-0">
            {selected ? (
              <BotDetailPanel
                key={selected.bot_id}
                bot={selected}
                onError={(m) => toast.error(m)}
                onChanged={refresh}
                onPoll={pollRefresh}
                onAddHost={() => {
                  setHostBotId(selected.bot_id);
                }}
              />
            ) : (
              <div className="rounded-sm bg-zinc-900/60 p-10 text-center text-regular text-content-muted">
                Select a bot to manage it.
              </div>
            )}
          </div>
        </div>
      )}

      {createBotOpen && <CreateBotDialog onClose={() => setCreateBotOpen(false)} onCreated={(bot) => {
        setCreateBotOpen(false);
        // Seed the list with what the POST returned instead of waiting for the
        // refetch: the host wizard resolves its bot out of `bots`, so
        // opening before the round-trip lands would show it an empty selection.
        setBots((prev) => (prev.some((b) => b.bot_id === bot.bot_id) ? prev : [bot, ...prev]));
        setSelectedId(bot.bot_id);
        // A bot identity can't do anything until some device runs it — carry on
        // into that rather than ending the flow on an inert row.
        setHostBotId(bot.bot_id);
        void refresh({ silent: true });
      }} />}
      {hostBotId !== undefined && (
        <CreateHostWizard
          bots={bots}
          initialBotId={hostBotId}
          onClose={() => {
            setHostBotId(undefined);
          }}
          onDone={refresh}
        />
      )}
    </section>
  );
}
