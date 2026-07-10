import { useEffect, useRef, useState } from "react";
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
import {
  disableBot,
  enableBot,
  deleteBot,
  updateBotProfile,
  refreshBotStatus,
  getBotStatus,
} from "@/api/bots";
import { uploadBotAvatar } from "@/api/avatars";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
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
  onPoll,
}: {
  bot: BotItem;
  channels: Channel[];
  onIssue: (botId: string) => void;
  onError: (msg: string) => void;
  onChanged: () => void;
  /** Silent background refetch for "live while open" (item 8) — no spinner. */
  onPoll: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");

  // A manual "Update status now" lifecycle (item 4) is actively polling. While
  // true, the live-while-open poll below stands down so the two don't overlap.
  const refreshLifecycleActive = useRef(false);

  // "Live while open" (item 8): no new websocket — just a bounded background
  // refetch so status set elsewhere (another admin, the bot, the scheduler)
  // shows up. Poll every ~20s and on window focus / tab becoming visible.
  // Paused while the manual refresh lifecycle is mid-poll, and skipped while
  // the tab is hidden. Cleaned up on unmount / bot change.
  useEffect(() => {
    const tick = () => {
      if (refreshLifecycleActive.current) return;
      if (document.visibilityState === "hidden") return;
      onPoll();
    };
    const id = window.setInterval(tick, 20_000);
    const onFocus = () => tick();
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [bot.bot_id, onPoll]);

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
          <BotOverview
            bot={bot}
            channels={channels}
            onIssue={onIssue}
            onError={onError}
            onChanged={onChanged}
            lifecycleActiveRef={refreshLifecycleActive}
          />
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
  lifecycleActiveRef,
}: {
  bot: BotItem;
  channels: Channel[];
  onIssue: (botId: string) => void;
  onError: (msg: string) => void;
  onChanged: () => void;
  lifecycleActiveRef: React.MutableRefObject<boolean>;
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

      {bot.can_manage && (
        <BotStatusEditor
          bot={bot}
          onError={onError}
          onChanged={onChanged}
          lifecycleActiveRef={lifecycleActiveRef}
        />
      )}

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
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40 transition-colors"
        >
          {added ? "Added ✓" : "Add"}
        </button>
      </div>

      {bot.can_manage && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onIssue(bot.bot_id)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
          >
            <KeyRound className="w-3.5 h-3.5" />
            Issue token
          </button>
          {/* status editor is rendered above; token/enable/delete stay grouped here */}
          <button
            type="button"
            onClick={toggleDisabled}
            disabled={toggling}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${
              bot.is_disabled
                ? "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
                : "bg-red-950/40 text-red-300 hover:bg-red-950/70"
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
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/70 disabled:opacity-40 transition-colors"
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
  lifecycleActiveRef,
}: {
  bot: BotItem;
  onError: (msg: string) => void;
  onChanged: () => void;
  lifecycleActiveRef: React.MutableRefObject<boolean>;
}) {
  const [statusEmoji, setStatusEmoji] = useState(bot.status_emoji ?? "");
  const [statusText, setStatusText] = useState(bot.status_text ?? "");
  const [description, setDescription] = useState(bot.description ?? "");
  // Re-seed the drafts when a refetch brings new values — e.g. the agent just
  // wrote its status via set_status after "Update status now". Without this the
  // inputs keep showing the stale pre-refresh text (useState seeds only once),
  // and a later Save would silently overwrite the agent's fresh status.
  useEffect(() => {
    setStatusEmoji(bot.status_emoji ?? "");
    setStatusText(bot.status_text ?? "");
    setDescription(bot.description ?? "");
  }, [bot.status_emoji, bot.status_text, bot.description]);
  const [auto, setAuto] = useState(bot.status_auto_update ?? false);
  const [prompt, setPrompt] = useState(bot.status_update_prompt ?? "");
  const [interval, setIntervalMin] = useState(
    bot.status_update_interval_minutes != null ? String(bot.status_update_interval_minutes) : "60"
  );
  const [busy, setBusy] = useState(false);

  // Manual "Update status now" completion lifecycle (item 4). Instead of blind
  // 5/15/30s reloads, we ask the agent then POLL the bot's status every ~4s for
  // up to ~60s, watching for status_updated_at to advance past the value we
  // captured at click time. Newer → re-pull + a transient "✓ status updated".
  // 60s with no change → a soft "still working" note (not an error). The button
  // shows "Waiting for the agent…" throughout.
  type RefreshPhase = "idle" | "waiting" | "done" | "timeout";
  const [refreshPhase, setRefreshPhase] = useState<RefreshPhase>("idle");
  // All pending timeouts (poll ticks + the transient-state auto-clear) live here
  // so unmount / bot change tears every one down.
  const timersRef = useRef<number[]>([]);
  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };
  useEffect(
    () => () => {
      clearTimers();
      lifecycleActiveRef.current = false;
    },
    [bot.bot_id, lifecycleActiveRef]
  );

  const POLL_INTERVAL_MS = 4000;
  const POLL_BUDGET_MS = 60_000;
  const TRANSIENT_MS = 5000;

  async function refreshNow() {
    if (refreshPhase === "waiting") return;
    // "before" anchor — a status write is detected when the server reports a
    // strictly newer timestamp than this. Captured before we ask the agent.
    const before = bot.status_updated_at ? Date.parse(bot.status_updated_at) : 0;
    clearTimers();
    setRefreshPhase("waiting");
    try {
      await refreshBotStatus(bot.bot_id);
      toast.success("Asked the bot to update its status");
    } catch (e) {
      onError(String(e));
      setRefreshPhase("idle");
      return;
    }

    lifecycleActiveRef.current = true;
    const deadline = Date.now() + POLL_BUDGET_MS;
    const finish = (phase: "done" | "timeout") => {
      lifecycleActiveRef.current = false;
      setRefreshPhase(phase);
      // Auto-clear the transient state back to idle.
      timersRef.current.push(
        window.setTimeout(() => setRefreshPhase("idle"), TRANSIENT_MS)
      );
    };
    const poll = async () => {
      try {
        const st = await getBotStatus(bot.bot_id);
        const updated = st.status_updated_at ? Date.parse(st.status_updated_at) : 0;
        if (updated > before) {
          onChanged(); // re-pull the full profile → drafts re-seed below
          finish("done");
          return;
        }
      } catch {
        // Transient read error — keep polling until the budget runs out.
      }
      if (Date.now() >= deadline) {
        finish("timeout");
        return;
      }
      timersRef.current.push(window.setTimeout(poll, POLL_INTERVAL_MS));
    };
    timersRef.current.push(window.setTimeout(poll, POLL_INTERVAL_MS));
  }

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

  async function handleAvatarUpload(file: File) {
    const url = await uploadBotAvatar(bot.bot_id, file);
    onChanged(); // refetch so avatar_url updates wherever the bot is shown
    return url;
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-3">
      <p className="text-xs font-semibold text-zinc-400">Status & information</p>

      <div className="flex items-center gap-3">
        <AvatarUpload
          name={bot.display_name || bot.username}
          id={bot.bot_id}
          src={bot.avatar_url}
          size="md"
          onUpload={handleAvatarUpload}
        />
        <span className="text-[11px] text-zinc-500">Click the avatar to upload an image (PNG/JPEG/WebP/GIF, ≤5 MB)</span>
      </div>

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

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => void refreshNow()}
          disabled={refreshPhase === "waiting"}
          title="Ask the agent to update its own status now"
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 transition-colors"
        >
          {refreshPhase === "waiting"
            ? "Waiting for the agent…"
            : refreshPhase === "done"
              ? "✓ status updated"
              : "Update status now"}
        </button>
      </div>
      {refreshPhase === "timeout" && (
        <p className="text-[11px] text-amber-500/80 leading-snug">
          The agent hasn't responded yet — it may still be working. Its status will update
          here on its own once it writes back.
        </p>
      )}
      <p className="text-[11px] text-zinc-600 leading-snug">
        Runs the status prompt via the normal prompt path (needs the bot online; opens a
        DM with it automatically if you don't have one). Owner/admin only.
      </p>
    </div>
  );
}
