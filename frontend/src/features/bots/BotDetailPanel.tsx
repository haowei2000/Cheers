import { useState } from "react";
import toast from "react-hot-toast";
import {
  Bot,
  CircleDot,
  Ban,
  Power,
  KeyRound,
  ShieldCheck,
  Activity,
  Copy,
  Check,
  Info,
  Trash2,
} from "lucide-react";
import { disableBot, enableBot, deleteBot, updateBotProfile } from "@/api/bots";
import { addChannelMember } from "@/api/channels";
import { BotPostureSection } from "./BotPostureSection";
import { BotPermissionGrantsSection } from "./BotPermissionGrantsSection";
import { BotActivitySection } from "./BotActivitySection";
import { BotConnectionHistorySection } from "./BotConnectionHistorySection";
import type { BotItem, Channel } from "@/types";

export function CopyButton({ value, label }: { value: string; label?: string }) {
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
      {done ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {label ?? (done ? "Copied" : "Copy")}
    </button>
  );
}

type Tab = "overview" | "permissions" | "events";

const TABS: { id: Tab; label: string; icon: typeof Info }[] = [
  { id: "overview", label: "Overview", icon: Info },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "events", label: "Events", icon: Activity },
];

/**
 * Right-pane detail view for the selected bot — replaces the old nested BotPermissionsDialog
 * modal. Identity + actions live in Overview; Permissions folds in Posture + Grants inline;
 * Events shows the per-bot ACP event log.
 */
export function BotDetailPanel({
  bot,
  channels,
  onIssue,
  onError,
  onChanged,
}: {
  bot: BotItem;
  channels: Channel[];
  onIssue: (botId: string) => void;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-zinc-800">
        <div className="w-10 h-10 rounded-lg bg-indigo-900/50 flex items-center justify-center flex-shrink-0">
          <Bot className="w-5 h-5 text-indigo-300" />
        </div>
        <div className="min-w-0">
          <p className="font-medium text-zinc-100 truncate">
            {bot.status_emoji && <span className="mr-1">{bot.status_emoji}</span>}
            {bot.display_name || bot.username}
          </p>
          <p className="text-xs text-zinc-500 truncate">
            {bot.status_text ? bot.status_text : `@${bot.username}`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {bot.is_disabled && (
            <span className="inline-flex items-center gap-1 text-[11px] text-red-400">
              <Ban className="w-3 h-3" />
              Disabled
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1 text-[11px] ${
              bot.is_online ? "text-emerald-400" : "text-zinc-500"
            }`}
            title={bot.is_online ? "Connector attached" : "Connector not attached"}
          >
            <CircleDot className="w-3 h-3" />
            {bot.is_online ? "online" : "offline"}
          </span>
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-zinc-800 px-2">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-indigo-500 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      <div className="p-4">
        {tab === "overview" && (
          <BotOverview bot={bot} channels={channels} onIssue={onIssue} onError={onError} onChanged={onChanged} />
        )}
        {tab === "permissions" && (
          <div className="space-y-4">
            <BotPostureSection botId={bot.bot_id} />
            <BotPermissionGrantsSection botId={bot.bot_id} />
          </div>
        )}
        {tab === "events" && (
          <div className="space-y-4">
            <BotConnectionHistorySection botId={bot.bot_id} />
            <BotActivitySection botId={bot.bot_id} />
          </div>
        )}
      </div>
    </div>
  );
}

function BotOverview({
  bot,
  channels,
  onIssue,
  onError,
  onChanged,
}: {
  bot: BotItem;
  channels: Channel[];
  onIssue: (botId: string) => void;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [channelId, setChannelId] = useState("");
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function add() {
    if (!channelId || busy) return;
    setBusy(true);
    try {
      await addChannelMember(channelId, { member_id: bot.bot_id, member_type: "bot" });
      setAdded(true);
      setTimeout(() => setAdded(false), 1500);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Permanently delete ${bot.display_name || bot.username}? This removes it from all channels and can't be undone.`
      )
    )
      return;
    setToggling(true);
    try {
      await deleteBot(bot.bot_id);
      toast.success(`Deleted ${bot.display_name || bot.username}`);
      onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setToggling(false);
    }
  }

  async function toggleDisabled() {
    if (toggling) return;
    setToggling(true);
    try {
      if (bot.is_disabled) {
        await enableBot(bot.bot_id);
        toast.success(`Enabled ${bot.display_name || bot.username}`);
      } else {
        await disableBot(bot.bot_id);
        toast.success(`Disabled ${bot.display_name || bot.username} (connector disconnected)`);
      }
      onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500 w-14 shrink-0">bot_id</span>
        <code className="flex-1 truncate bg-zinc-800 px-2 py-1 rounded text-zinc-400">{bot.bot_id}</code>
        <CopyButton value={bot.bot_id} label="" />
      </div>

      {bot.can_manage && <BotStatusEditor bot={bot} onError={onError} onChanged={onChanged} />}

      <div className="flex items-center gap-2">
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

      {bot.can_manage && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onIssue(bot.bot_id)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <KeyRound className="w-3.5 h-3.5" />
            Issue token
          </button>
          {/* status editor is rendered above; token/enable/delete stay grouped here */}
          <button
            type="button"
            onClick={toggleDisabled}
            disabled={toggling}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${
              bot.is_disabled
                ? "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                : "border-red-900/60 text-red-300 hover:bg-red-950/40"
            }`}
          >
            {bot.is_disabled ? <Power className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
            {bot.is_disabled ? "Enable bot" : "Disable bot"}
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={toggling}
            title="Permanently delete this bot"
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-red-900/60 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Manager editor for a bot's status line, "information" (description), and the
 * scheduled self-update. Three ways the status gets set — manual (this form), the
 * bot writing its own via POST /bots/:id/self-status (bot token), and the schedule
 * (connector re-runs the prompt every N minutes and writes back) — all land in the
 * same fields; this form owns the manual path + the schedule config.
 */
function BotStatusEditor({
  bot,
  onError,
  onChanged,
}: {
  bot: BotItem;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [statusEmoji, setStatusEmoji] = useState(bot.status_emoji ?? "");
  const [statusText, setStatusText] = useState(bot.status_text ?? "");
  const [description, setDescription] = useState(bot.description ?? "");
  const [auto, setAuto] = useState(bot.status_auto_update ?? false);
  const [prompt, setPrompt] = useState(bot.status_update_prompt ?? "");
  const [interval, setIntervalMin] = useState(
    bot.status_update_interval_minutes != null ? String(bot.status_update_interval_minutes) : "60"
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    if (auto && !prompt.trim()) {
      onError("A prompt is required to enable scheduled self-update");
      return;
    }
    setBusy(true);
    try {
      await updateBotProfile(bot.bot_id, {
        status_emoji: statusEmoji.trim(),
        status_text: statusText.trim(),
        description: description.trim(),
        status_auto_update: auto,
        status_update_prompt: prompt.trim(),
        status_update_interval_minutes: Number(interval) || 60,
      });
      toast.success("Bot profile saved");
      onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-500/60";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-3">
      <p className="text-xs font-semibold text-zinc-400">Status & information</p>

      <div className="flex gap-2">
        <input
          value={statusEmoji}
          onChange={(e) => setStatusEmoji(e.target.value)}
          placeholder="🤖"
          maxLength={8}
          className={`${inputCls} w-14 text-center`}
          aria-label="Status emoji"
        />
        <input
          value={statusText}
          onChange={(e) => setStatusText(e.target.value)}
          placeholder="Short status (e.g. reviewing PRs)"
          maxLength={140}
          className={inputCls}
          aria-label="Status text"
        />
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Information — what this bot does"
        rows={2}
        className={`${inputCls} resize-y`}
        aria-label="Bot description"
      />

      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          className="accent-indigo-500"
        />
        Auto-refresh status on a schedule (asks the bot with the prompt below)
      </label>

      {auto && (
        <div className="space-y-2 pl-1">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Prompt the bot runs to compose its own status, e.g. 'Summarize what you're working on in under 10 words.'"
            rows={2}
            className={`${inputCls} resize-y`}
            aria-label="Status update prompt"
          />
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Every</span>
            <input
              type="number"
              min={5}
              value={interval}
              onChange={(e) => setIntervalMin(e.target.value)}
              className={`${inputCls} w-20`}
              aria-label="Interval minutes"
            />
            <span>minutes (min 5)</span>
          </div>
          <p className="text-[11px] text-zinc-600 leading-snug">
            The connector runs this prompt on the schedule and posts the answer back via the
            bot's token. Requires the bot to be online.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
