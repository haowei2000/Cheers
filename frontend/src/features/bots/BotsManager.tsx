import { useEffect, useState, useCallback, type FormEvent } from "react";
import {
  Bot,
  Plus,
  KeyRound,
  Copy,
  Check,
  RefreshCw,
  CircleDot,
  Wand2,
} from "lucide-react";
import {
  listBots,
  createBot,
  issueBotToken,
  type IssuedToken,
} from "@/api/bots";
import { listChannels, addChannelMember } from "@/api/channels";
import { Dialog } from "@/components/ui/dialog";
import { BotOnboardingWizard } from "./BotOnboardingWizard";
import type { BotItem, Channel } from "@/types";

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
    >
      {done ? (
        <Check className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
      {label ?? (done ? "Copied" : "Copy")}
    </button>
  );
}

function BotCard({
  bot,
  channels,
  onIssue,
  onError,
}: {
  bot: BotItem;
  channels: Channel[];
  onIssue: (botId: string) => void;
  onError: (msg: string) => void;
}) {
  const [channelId, setChannelId] = useState("");
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!channelId || busy) return;
    setBusy(true);
    try {
      await addChannelMember(channelId, {
        member_id: bot.bot_id,
        member_type: "bot",
      });
      setAdded(true);
      setTimeout(() => setAdded(false), 1500);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-indigo-900/50 flex items-center justify-center flex-shrink-0">
          <Bot className="w-5 h-5 text-indigo-300" />
        </div>
        <div className="min-w-0">
          <p className="font-medium text-zinc-100 text-sm truncate">
            {bot.display_name || bot.username}
          </p>
          <p className="text-xs text-zinc-500">@{bot.username}</p>
        </div>
        <span
          className={`ml-auto inline-flex items-center gap-1 text-[11px] ${
            bot.is_online ? "text-emerald-400" : "text-zinc-500"
          }`}
          title={bot.is_online ? "连接器已接入" : "连接器未接入"}
        >
          <CircleDot className="w-3 h-3" />
          {bot.is_online ? "online" : "offline"}
        </span>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500">bot_id</span>
        <code className="flex-1 truncate bg-zinc-800 px-2 py-1 rounded text-zinc-400">
          {bot.bot_id}
        </code>
        <CopyButton value={bot.bot_id} label="" />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onIssue(bot.bot_id)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
        >
          <KeyRound className="w-3.5 h-3.5" />
          Issue token
        </button>

        <select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="flex-1 min-w-0 rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-indigo-500/60"
        >
          <option value="">Add to channel…</option>
          {channels.map((c) => (
            <option key={c.channel_id} value={c.channel_id}>
              #{c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          disabled={!channelId || busy}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 transition-colors"
        >
          {added ? "Added ✓" : "Add"}
        </button>
      </div>
    </div>
  );
}

export function BotsManager() {
  const [bots, setBots] = useState<BotItem[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [b, c] = await Promise.all([listBots(), listChannels()]);
      setBots(b);
      setChannels(c);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      await createBot({
        username: username.trim(),
        display_name: displayName.trim() || undefined,
      });
      setUsername("");
      setDisplayName("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function onIssue(botId: string) {
    setError(null);
    try {
      setIssued(await issueBotToken(botId));
    } catch (e) {
      setError(String(e));
    }
  }

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
          Connect an agent
        </button>
        <button
          type="button"
          onClick={refresh}
          className="text-zinc-500 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </h2>

      <div className="space-y-4">
        {/* Create */}
        <form
          onSubmit={onCreate}
          className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex flex-wrap items-end gap-3"
        >
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-zinc-500 block mb-1">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="opencode-main"
              className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500/60"
            />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-zinc-500 block mb-1">
              Display name
            </label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="OpenCode"
              className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500/60"
            />
          </div>
          <button
            type="submit"
            disabled={!username.trim() || creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Register bot
          </button>
        </form>

        {error && (
          <p className="text-xs text-red-400 px-1 break-words">{error}</p>
        )}

        {/* List */}
        {bots.length === 0 && !loading ? (
          <p className="text-sm text-zinc-600 px-1">
            No bots yet. Register one, issue its token, and connect it with the
            Rust ACP connector.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {bots.map((bot) => (
              <BotCard
                key={bot.bot_id}
                bot={bot}
                channels={channels}
                onIssue={onIssue}
                onError={setError}
              />
            ))}
          </div>
        )}
      </div>

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
