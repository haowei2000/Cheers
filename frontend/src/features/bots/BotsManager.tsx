import { useEffect, useState, useCallback } from "react";
import { Bot, KeyRound, RefreshCw, CircleDot, Ban, Wand2 } from "lucide-react";
import {
  listBots,
  issueBotToken,
  type IssuedToken,
} from "@/api/bots";
import { listChannels } from "@/api/channels";
import { Dialog } from "@/components/ui/dialog";
import { BotOnboardingWizard } from "./BotOnboardingWizard";
import { BotDetailPanel, CopyButton } from "./BotDetailPanel";
import type { BotItem, Channel } from "@/types";

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
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900"
      }`}
    >
      <div className="w-8 h-8 rounded-lg bg-indigo-900/50 flex items-center justify-center flex-shrink-0">
        <Bot className="w-4 h-4 text-indigo-300" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{bot.display_name || bot.username}</p>
        <p className="text-[11px] text-zinc-500 truncate">@{bot.username}</p>
      </div>
      {bot.is_disabled ? (
        <Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
      ) : (
        <CircleDot
          className={`w-3 h-3 flex-shrink-0 ${bot.is_online ? "text-emerald-400" : "text-zinc-600"}`}
        />
      )}
    </button>
  );
}

export function BotsManager() {
  const [bots, setBots] = useState<BotItem[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [b, c] = await Promise.all([listBots(), listChannels()]);
      setBots(b);
      setChannels(c);
    } catch (e) {
      setError(String(e));
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

  async function onIssue(botId: string) {
    setError(null);
    try {
      setIssued(await issueBotToken(botId));
    } catch (e) {
      setError(String(e));
    }
  }

  const selected = bots.find((b) => b.bot_id === selectedId) ?? null;

  return (
    <section>
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-2">
        <Bot className="w-3.5 h-3.5" />
        Bots
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium normal-case tracking-normal text-white hover:bg-indigo-500"
        >
          <Wand2 className="w-3.5 h-3.5" />
          Add bot
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-zinc-500 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </h2>

      {error && <p className="text-xs text-red-400 px-1 break-words mb-3">{error}</p>}

      {bots.length === 0 && !loading ? (
        <p className="text-sm text-zinc-600 px-1">
          No bots yet. Click <span className="text-zinc-400">Add bot</span> to register one and
          connect it with the Rust ACP connector.
        </p>
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
                channels={channels}
                onIssue={onIssue}
                onError={setError}
                onChanged={refresh}
                onPoll={pollRefresh}
              />
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-600">
                Select a bot to manage it.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Token modal — shown once */}
      {issued && (
        <Dialog
          title={
            <span className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-indigo-400" /> Agent Bridge token
            </span>
          }
          onClose={() => setIssued(null)}
          maxWidth="max-w-lg"
        >
          <p className="text-xs text-amber-400">
            {issued.note ?? "Store this token now — shown only once."}
          </p>
          <div className="rounded-lg bg-zinc-950 border border-zinc-800 p-3">
            <code className="text-xs text-emerald-300 break-all">{issued.token}</code>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">
              Set this as <code>bot_token_env</code> for the connector account.
            </span>
            <CopyButton value={issued.token} label="Copy token" />
          </div>
        </Dialog>
      )}

      {wizardOpen && (
        <BotOnboardingWizard
          bots={bots}
          onClose={() => setWizardOpen(false)}
          onDone={refresh}
        />
      )}
    </section>
  );
}
