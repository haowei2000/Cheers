import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
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
  Pencil,
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
import { Avatar } from "@/components/ui/avatar";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";
import { Field, SectionHead, MetaRow } from "@/components/ui/field";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/cn";
import { addChannelMember } from "@/api/channels";
import { BotPostureSection } from "./BotPostureSection";
import { BotPermissionGrantsSection } from "./BotPermissionGrantsSection";
import { BotToBotGrantsSection } from "./BotToBotGrantsSection";
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
          // The Agent Bridge token is shown only once — never let a copy failure
          // be silent, or the value is lost. Point the user at the manual path.
          toast.error("Clipboard unavailable — select and copy manually");
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
 * modal. Built on the shared identity-card anatomy (DESIGN.md §2.13–2.15): identity header →
 * sectioned Overview (status editor, Details, Danger zone) → Permissions → Events.
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

  async function handleAvatarUpload(file: File) {
    const url = await uploadBotAvatar(bot.bot_id, file);
    onChanged(); // refetch so avatar_url updates wherever the bot is shown
    return url;
  }

  const name = bot.display_name || bot.username;

  return (
    <div className="rounded-xl bg-zinc-900">
      {/* Identity header — the avatar is the upload entry (managers); presence dot
          per §2.7 sits on it, with the online/offline pill carrying the text. */}
      <div className="flex items-center gap-3 p-4 border-b border-zinc-800">
        <div className="relative flex-shrink-0">
          {bot.can_manage ? (
            <AvatarUpload
              name={name}
              id={bot.bot_id}
              src={bot.avatar_url}
              size="lg"
              onUpload={handleAvatarUpload}
            />
          ) : (
            <Avatar name={name} id={bot.bot_id} src={bot.avatar_url} size="lg" />
          )}
          <span
            className={cn(
              "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-zinc-900",
              bot.is_online ? "bg-emerald-500" : "bg-zinc-600"
            )}
            aria-hidden
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-zinc-100 truncate">
            {bot.status_emoji && <span className="mr-1">{bot.status_emoji}</span>}
            {name}
          </p>
          <p className="text-sm text-zinc-400 truncate">
            @{bot.username}
            {bot.status_text ? ` · ${bot.status_text}` : ""}
          </p>
        </div>
        <div className="ml-auto flex flex-shrink-0 items-center gap-2.5">
          {bot.is_disabled && (
            <span className="inline-flex items-center gap-1 text-[11px] text-red-400">
              <Ban className="w-3 h-3" />
              Disabled
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[11px]",
              bot.is_online ? "text-emerald-400" : "text-zinc-400"
            )}
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
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
                active
                  ? "border-indigo-500 text-zinc-100"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              )}
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
            <BotToBotGrantsSection botId={bot.bot_id} />
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
    <div className="space-y-5">
      {bot.can_manage && (
        <BotStatusEditor
          bot={bot}
          onError={onError}
          onChanged={onChanged}
          lifecycleActiveRef={lifecycleActiveRef}
        />
      )}

      {bot.can_manage && <div className="border-t border-zinc-800" />}

      {/* Details — Bot ID / Bridge token / Channels, one row form (§2.13) */}
      <section className="space-y-3">
        <SectionHead>Details</SectionHead>
        <MetaRow label="Bot ID">
          <code className="flex-1 truncate rounded bg-zinc-800 px-2 py-1 text-zinc-400">
            {bot.bot_id}
          </code>
          <CopyButton value={bot.bot_id} label="" />
        </MetaRow>
        {bot.can_manage && (
          <MetaRow label="Bridge token">
            <Tip content="Shown once when issued — copy it right away.">
              <Button size="sm" variant="secondary" onClick={() => onIssue(bot.bot_id)}>
                <KeyRound className="w-3.5 h-3.5" />
                Issue token
              </Button>
            </Tip>
          </MetaRow>
        )}
        <MetaRow label="Channels">
          <Select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            aria-label="Add bot to channel"
            className="h-8 min-w-0 flex-1 text-xs"
          >
            <option value="">Add to channel…</option>
            {channels.map((c) => (
              <option key={c.channel_id} value={c.channel_id}>
                #{c.name}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="secondary" onClick={add} disabled={!channelId || busy}>
            {added ? "Added ✓" : "Add"}
          </Button>
        </MetaRow>
      </section>

      {/* Danger zone — trailing, one row; consequences in hover help (§2.15) */}
      {bot.can_manage && (
        <>
          <div className="border-t border-zinc-800" />
          <section className="flex items-center justify-between gap-3">
            <SectionHead className="mb-0">Danger zone</SectionHead>
            <div className="flex items-center gap-2">
              <Tip
                align="end"
                content={
                  bot.is_disabled
                    ? "Re-enables the bot so its connector can attach again."
                    : "Disconnects the connector; the bot goes offline until re-enabled."
                }
              >
                <button
                  type="button"
                  onClick={toggleDisabled}
                  disabled={toggling}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors disabled:opacity-40",
                    bot.is_disabled
                      ? "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
                      : "bg-red-950/40 text-red-300 hover:bg-red-950/70"
                  )}
                >
                  {bot.is_disabled ? <Power className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                  {bot.is_disabled ? "Enable bot" : "Disable bot"}
                </button>
              </Tip>
              <Tip
                align="end"
                content="Removes it from all channels — asks you to confirm first. This can't be undone."
              >
                <button
                  type="button"
                  onClick={remove}
                  disabled={toggling}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/70 disabled:opacity-40 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete…
                </button>
              </Tip>
            </div>
          </section>
        </>
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
  const [externalProcessor, setExternalProcessor] = useState(bot.external_processor ?? false);
  const [processorName, setProcessorName] = useState(bot.processor_name ?? "");
  const [processorPrivacyUrl, setProcessorPrivacyUrl] = useState(bot.processor_privacy_url ?? "");
  const [processorDataUse, setProcessorDataUse] = useState(bot.processor_data_use ?? "");
  const [processorPolicyVersion, setProcessorPolicyVersion] = useState(bot.processor_policy_version ?? "1");
  // Re-seed the drafts when a refetch brings new values — e.g. the agent just
  // wrote its status via set_status after "Update status now". Without this the
  // inputs keep showing the stale pre-refresh text (useState seeds only once),
  // and a later Save would silently overwrite the agent's fresh status.
  useEffect(() => {
    setStatusEmoji(bot.status_emoji ?? "");
    setStatusText(bot.status_text ?? "");
    setDescription(bot.description ?? "");
    setExternalProcessor(bot.external_processor ?? false);
    setProcessorName(bot.processor_name ?? "");
    setProcessorPrivacyUrl(bot.processor_privacy_url ?? "");
    setProcessorDataUse(bot.processor_data_use ?? "");
    setProcessorPolicyVersion(bot.processor_policy_version ?? "1");
  }, [bot.status_emoji, bot.status_text, bot.description, bot.external_processor, bot.processor_name, bot.processor_privacy_url, bot.processor_data_use, bot.processor_policy_version]);
  const [auto, setAuto] = useState(bot.status_auto_update ?? false);
  const [prompt, setPrompt] = useState(bot.status_update_prompt ?? "");
  const [interval, setIntervalMin] = useState(
    bot.status_update_interval_minutes != null ? String(bot.status_update_interval_minutes) : "60"
  );
  const [busy, setBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  // The status prompt is a low-frequency edit, so it lives behind an "Edit
  // prompt" button that opens a dialog instead of taking a permanent textarea.
  // The dialog edits a draft; Done commits it into `prompt`, Cancel discards —
  // the profile itself is still persisted by the card's Save button.
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");

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
      // Validation stays inline next to the form; onError is the API-failure path.
      setPromptError("A prompt is required to enable scheduled self-update");
      return;
    }
    setPromptError(null);
    if (externalProcessor && (!processorName.trim() || !processorDataUse.trim() || !processorPrivacyUrl.startsWith("https://"))) {
      setPromptError("External AI requires a provider name, data-use disclosure, and HTTPS privacy URL");
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
        external_processor: externalProcessor,
        processor_name: processorName.trim(),
        processor_privacy_url: processorPrivacyUrl.trim(),
        processor_data_use: processorDataUse.trim(),
        processor_policy_version: processorPolicyVersion.trim() || "1",
      });
      toast.success("Bot profile saved");
      onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Status">
        <div className="flex gap-2">
          <Input
            value={statusEmoji}
            onChange={(e) => setStatusEmoji(e.target.value)}
            placeholder="🤖"
            maxLength={8}
            className="w-16 text-center"
            aria-label="Status emoji"
          />
          <Input
            value={statusText}
            onChange={(e) => setStatusText(e.target.value)}
            placeholder="Short status (e.g. reviewing PRs)"
            maxLength={140}
            aria-label="Status text"
          />
        </div>
      </Field>

      <Field label="Description">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this bot does"
          rows={3}
          className="resize-y"
          aria-label="Bot description"
        />
      </Field>

      <div className="rounded-xl border border-zinc-800 p-4 space-y-3">
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={externalProcessor} onChange={(e) => setExternalProcessor(e.target.checked)} className="accent-indigo-500" />
          Sends channel data to an external AI provider
        </label>
        {externalProcessor && (
          <>
            <Field label="Provider name"><Input value={processorName} onChange={(e) => setProcessorName(e.target.value)} placeholder="OpenAI, Anthropic, or operator name" /></Field>
            <Field label="Provider privacy URL"><Input value={processorPrivacyUrl} onChange={(e) => setProcessorPrivacyUrl(e.target.value)} placeholder="https://…" /></Field>
            <Field label="Data use shown to members"><Textarea value={processorDataUse} onChange={(e) => setProcessorDataUse(e.target.value)} rows={2} placeholder="Messages and selected workspace context are sent to generate replies." /></Field>
            <Field label="Disclosure version"><Input value={processorPolicyVersion} onChange={(e) => setProcessorPolicyVersion(e.target.value)} placeholder="1" /></Field>
            <p className="text-xs text-zinc-400">Changing the disclosure version requires members to consent again before their next AI-directed message.</p>
          </>
        )}
      </div>

      {/* Auto-refresh — one row. The how/why is hover help; the prompt is a dialog. */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
            className="accent-indigo-500"
          />
          Auto-refresh status
        </label>
        <Tip content="Asks the bot with the status prompt on a schedule (min 5 minutes) and writes the answer back. Needs the bot online." />
        {auto && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-zinc-400">Every</span>
            <Input
              type="number"
              min={5}
              value={interval}
              onChange={(e) => setIntervalMin(e.target.value)}
              className="h-8 w-16 text-center"
              aria-label="Interval minutes"
            />
            <span className="text-xs text-zinc-400">min</span>
            <Tip
              align="end"
              content={`Current prompt: “${prompt.trim() || "none set"}”. Click to edit.`}
            >
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setPromptDraft(prompt);
                  setPromptOpen(true);
                }}
              >
                <Pencil className="w-3 h-3" />
                Edit prompt
              </Button>
            </Tip>
          </div>
        )}
      </div>

      {promptError && <p className="text-xs text-red-400">{promptError}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save profile"}
        </Button>
        <Tip content="Runs the status prompt via a DM with the bot right now — owner/admin only.">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void refreshNow()}
            disabled={refreshPhase === "waiting"}
          >
            {refreshPhase === "waiting"
              ? "Waiting for the agent…"
              : refreshPhase === "done"
                ? "✓ status updated"
                : "Update status now"}
          </Button>
        </Tip>
      </div>

      {refreshPhase === "timeout" && (
        <p className="text-[11px] text-amber-400/80 leading-snug">
          The agent hasn't responded yet — it may still be working. Its status will update
          here on its own once it writes back.
        </p>
      )}

      {promptOpen && (
        <Dialog title="Status prompt" onClose={() => setPromptOpen(false)} maxWidth="max-w-md">
          <Textarea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            placeholder="Prompt the bot runs to compose its own status, e.g. 'Summarize what you're working on in under 10 words.'"
            rows={4}
            autoFocus
            aria-label="Status update prompt"
          />
          <p className="text-xs text-zinc-400">
            The bot answers this prompt on the schedule and the reply becomes its status.
            Save the profile to apply your changes.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPromptOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setPrompt(promptDraft);
                setPromptOpen(false);
              }}
            >
              Done
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
