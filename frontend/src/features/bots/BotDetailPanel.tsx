import { Button as UiButton } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  CircleDot,
  Ban,
  Power,
  ShieldCheck,
  Activity,
  Copy,
  Check,
  Info,
  Pencil,
  Laptop,
  RefreshCw,
} from "lucide-react";
import {
  disableBot,
  enableBot,
  deleteBot,
  updateBotProfile,
  refreshBotStatus,
  getBotStatus,
  listConnectorHosts,
  type ConnectorHost,
} from "@/api/bots";
import { uploadBotAvatar } from "@/api/avatars";
import { Avatar } from "@/components/ui/avatar";
import { PresenceDot } from "@/components/ui/presence-dot";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/action-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, SectionHead } from "@/components/ui/field";
import { Tip } from "@/components/ui/tip";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { IconButton } from "@/components/ui/icon-button";
import { ItemList } from "@/components/ui/item";
import { cn } from "@/lib/cn";
import { messageOf } from "@/lib/notify";
import { HostItem } from "./HostItem";
import { BotPostureSection } from "./BotPostureSection";
import { BotPermissionGrantsSection } from "./BotPermissionGrantsSection";
import { BotToBotGrantsSection } from "./BotToBotGrantsSection";
import { BotActivitySection } from "./BotActivitySection";
import { BotConnectionHistorySection } from "./BotConnectionHistorySection";
import type { BotItem } from "@/types";

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const accessibleLabel = done ? "Copied" : label === "" ? "Copy Bot ID" : label ?? "Copy";
  return (
    <UiButton action="copy" variant="plain" content={label === "" ? "icon" : "iconText"}
      aria-label={accessibleLabel} title={accessibleLabel}
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // One-time credentials are shown only once — never let a copy failure
          // be silent, or the value is lost. Point the user at the manual path.
          toast.error("Clipboard unavailable — select and copy manually");
        }
      }}
      className="inline-flex items-center gap-1  text-content-primary hover:text-content-strong transition-colors"
    >
      {done ? <Check className="w-3.5 h-3.5 text-success-400" /> : <Copy className="w-3.5 h-3.5" />}
      {label ?? (done ? "Copied" : "Copy")}
    </UiButton>
  );
}

type Tab = "overview" | "terminals" | "permissions" | "events";

const TABS: { id: Tab; label: string; icon: typeof Info }[] = [
  { id: "overview", label: "Overview", icon: Info },
  { id: "terminals", label: "Hosts", icon: Laptop },
  { id: "permissions", label: "Access", icon: ShieldCheck },
  { id: "events", label: "Audit", icon: Activity },
];

function routeTab(value?: string): Tab {
  if (value === "hosts" || value === "terminals") return "terminals";
  if (value === "access" || value === "permissions") return "permissions";
  if (value === "audit" || value === "events") return "events";
  return "overview";
}

/**
 * Right-pane detail view for the selected bot — replaces the old nested BotPermissionsDialog
 * modal. Built on the shared identity-card anatomy (DESIGN.md §2.13–2.15): identity header →
 * sectioned Overview (status editor, Details, Danger zone) → Permissions → Events.
 */
export function BotDetailPanel({
  bot,
  onError,
  onChanged,
  onPoll,
  onAddHost,
  initialTab,
  onClose,
}: {
  bot: BotItem;
  onError: (msg: string) => void;
  onChanged: () => void;
  /** Silent background refetch for "live while open" (item 8) — no spinner. */
  onPoll: () => void;
  /** Starts the shared setup flow with this bot already selected. */
  onAddHost: () => void;
  initialTab?: string;
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(() => routeTab(initialTab));

  useEffect(() => setTab(routeTab(initialTab)), [initialTab, bot.bot_id]);

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
    <div className="rounded-sm bg-zinc-900">
      {/* Identity header — the avatar is the upload entry (managers); presence dot
          per §2.7 sits on it, with the online/offline pill carrying the text. */}
      <div className="flex items-start gap-3 pb-4 border-b border-zinc-800">
        <div className="relative flex-shrink-0">
          {bot.can_manage ? (
            <AvatarUpload
              name={name}
              id={bot.bot_id}
              src={bot.avatar_url}
              size="large"
              onUpload={handleAvatarUpload}
            />
          ) : (
            <Avatar name={name} id={bot.bot_id} src={bot.avatar_url} size="large" />
          )}
          <PresenceDot
            contentSize="large"
            className={cn(
              "absolute bottom-0 right-0 ring-zinc-900",
              bot.is_online ? "bg-emerald-500" : "bg-zinc-600"
            )}
            aria-hidden
          />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-content-primary truncate">
            {bot.status_emoji && <span className="mr-1">{bot.status_emoji}</span>}
            {name}
          </h2>
          <p className="text-regular text-content-muted truncate">
            @{bot.username}
            {bot.status_text ? ` · ${bot.status_text}` : ""}
          </p>
        </div>
        <div className="ml-auto flex flex-shrink-0 items-center gap-2">
          {bot.is_disabled && (
            <span className="inline-flex items-center gap-1 text-compact text-danger-400">
              <Ban className="w-3.5 h-3.5" />
              Disabled
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1 text-compact",
              bot.is_online ? "text-success-400" : "text-content-muted"
            )}
            title={bot.is_online ? "A host is online" : "No host is online"}
          >
            <CircleDot className="w-3.5 h-3.5" />
            {bot.is_online ? "online" : "offline"}
          </span>
          {onClose && <ActionButton action="close" context="windowChrome" accessibleLabel="Close bot details" onClick={onClose} />}
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <UiButton content="iconText" variant="plain" role="tab" aria-selected={active} selected={active}
              key={id}
              type="button"
              onClick={() => setTab(id)}
              controlSize="regular"
              className="inline-flex items-center gap-2 font-medium text-content-primary transition-colors hover:text-content-strong"
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </UiButton>
          );
        })}
      </div>

      <div className="pt-4">
        {tab === "overview" && (
          <BotOverview
            bot={bot}
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
        {tab === "terminals" && (
          bot.can_manage ? (
            <BotHostsSection
              botId={bot.bot_id}
              onError={onError}
              onAddHost={onAddHost}
            />
          ) : (
            <p className="text-compact text-content-muted">Only the bot owner or an administrator can view hosts.</p>
          )
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

function BotHostsSection({
  botId,
  onError,
  onAddHost,
}: {
  botId: string;
  onError: (msg: string) => void;
  onAddHost: () => void;
}) {
  const [items, setItems] = useState<ConnectorHost[]>([]);

  const load = async () => {
    try {
      setItems(await listConnectorHosts(botId));
    } catch (e) {
      onError(String(e));
    }
  };

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [botId]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionHead>Hosts</SectionHead>
          <p className="mt-1 max-w-2xl text-compact text-content-muted">
            A host is this bot running on a specific device. Each one has its own
            credential, agent, workspace, and connection state. One host is active at a time.
          </p>
        </div>
        <ActionButton
          action="add"
          context="toolbar"
          accessibleLabel="Add host"
          controlSize="compact"
          onClick={onAddHost}
        />
      </div>
      {items.length === 0 && (
        <p className="rounded-sm bg-zinc-800/60 p-3 text-compact text-content-muted">
          This bot has no hosts yet. Add one to choose where the bot runs.
        </p>
      )}
      <ItemList presentationLevel="medium" controlSize="regular">
        {items.map((item) => <HostItem key={item.host_id} item={{ ...item, bot_id: botId }} onChanged={load} />)}
      </ItemList>
    </section>
  );
}

function BotOverview({
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
  const [toggling, setToggling] = useState(false);
  const [pendingDanger, setPendingDanger] = useState<"disable" | "delete" | null>(null);

  async function remove() {
    setToggling(true);
    try {
      await deleteBot(bot.bot_id);
      toast.success(`Deleted ${bot.display_name || bot.username}`);
      setPendingDanger(null);
      onChanged();
    } catch (e) {
      onError(messageOf(e));
    } finally {
      setToggling(false);
    }
  }

  /** Enabling is harmless and goes straight through; disabling kicks whatever is
   *  connected right now, so it asks first. */
  async function setDisabled(disabled: boolean) {
    if (toggling) return;
    setToggling(true);
    try {
      if (disabled) {
        await disableBot(bot.bot_id);
        toast.success(`Disabled ${bot.display_name || bot.username} (host disconnected)`);
      } else {
        await enableBot(bot.bot_id);
        toast.success(`Enabled ${bot.display_name || bot.username}`);
      }
      setPendingDanger(null);
      onChanged();
    } catch (e) {
      onError(messageOf(e));
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

      <div className="flex min-w-0 items-center gap-3 text-compact text-content-muted">
        <span className="shrink-0">Bot ID</span>
        <code className="min-w-0 flex-1 truncate" title={bot.bot_id}>{bot.bot_id}</code>
        <CopyButton value={bot.bot_id} label="" />
      </div>

      {bot.can_manage && (
        <section className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-4">
          <SectionHead className="mb-0">Bot controls</SectionHead>
          <div className="flex items-center gap-2">
            <Tip align="end" content={bot.is_disabled ? "Enable bot — allow its host to reconnect." : "Disable bot — disconnect its host and keep it offline. Channels and history are kept."}>
              <IconButton
                label={bot.is_disabled ? "Enable bot" : "Disable bot"}
                tone={bot.is_disabled ? "neutral" : "danger"}
                controlSize="regular"
                onClick={() => (bot.is_disabled ? void setDisabled(false) : setPendingDanger("disable"))}
                disabled={toggling}
              >
                {bot.is_disabled ? <Power className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
              </IconButton>
            </Tip>
            <Tip align="end" content="Delete bot — remove it from all channels and delete its hosts. This cannot be undone.">
              <ActionButton action="delete" context="inlineEdit" accessibleLabel="Delete bot" controlSize="regular" onClick={() => setPendingDanger("delete")} disabled={toggling} />
            </Tip>
          </div>
        </section>
      )}

      {pendingDanger === "disable" && (
        <ConfirmDialog
          title="Disable this bot?"
          confirmAction="disable"
          confirmLabel="Disable bot"
          busy={toggling}
          onClose={() => setPendingDanger(null)}
          onConfirm={() => void setDisabled(true)}
        >
          <p>
            <strong className="text-content-primary">@{bot.username}</strong> is disconnected
            immediately and stops answering, including any work in progress.
          </p>
          <p className="text-content-muted">
            Nothing is deleted, and turning it back on restores it — its hosts and channels
            are untouched.
          </p>
        </ConfirmDialog>
      )}

      {pendingDanger === "delete" && (
        <ConfirmDialog
          title="Delete this bot?"
          confirmAction="delete"
          confirmLabel="Delete bot"
          busy={toggling}
          onClose={() => setPendingDanger(null)}
          onConfirm={() => void remove()}
        >
          <p>
            <strong className="text-content-primary">@{bot.username}</strong> is removed from every
            channel it belongs to, and its hosts stop working for good.
          </p>
          <p className="text-content-muted">
            This can't be undone. To take it offline temporarily, disable it instead.
          </p>
        </ConfirmDialog>
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
  const [externalDetailsOpen, setExternalDetailsOpen] = useState(false);

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
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <SectionHead className="mb-0">Profile</SectionHead>
        <div className="flex items-center gap-2">
          <Tip align="end" content={busy ? "Saving bot profile…" : "Save bot profile"}>
            <ActionButton action="save" context="inlineEdit" accessibleLabel="Save bot profile" controlSize="regular" onClick={() => void save()} disabled={busy} />
          </Tip>
          <Tip align="end" content={refreshPhase === "waiting" ? "Waiting for the agent to update its status…" : refreshPhase === "done" ? "Status updated" : "Update status now — ask the bot to refresh its status using the saved prompt."}>
            <IconButton label="Update bot status" controlSize="regular" onClick={() => void refreshNow()} disabled={refreshPhase === "waiting"} aria-busy={refreshPhase === "waiting"}>
              {refreshPhase === "done" ? <Check className="h-4 w-4 text-success-400" /> : <RefreshCw className={cn("h-4 w-4", refreshPhase === "waiting" && "animate-spin motion-reduce:animate-none")} />}
            </IconButton>
          </Tip>
        </div>
      </div>
      <div className="grid gap-4">
        <Field label="Status">
          <div className="flex gap-2">
          <Input
            value={statusEmoji}
            onChange={(e) => setStatusEmoji(e.target.value)}
            placeholder="🤖"
            maxLength={8}
            className="min-w-0 flex-[0.18] text-center"
            aria-label="Status emoji"
          />
          <Input
            value={statusText}
            onChange={(e) => setStatusText(e.target.value)}
            placeholder="Short status (e.g. reviewing PRs)"
            maxLength={140}
            className="min-w-0 flex-1"
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
      </div>

      <div className="border-t border-zinc-800 pt-4">
        <CheckboxField
          label="Sends channel data to an external AI provider"
          checked={externalProcessor}
          onChange={(e) => {
            setExternalProcessor(e.target.checked);
            if (e.target.checked) setExternalDetailsOpen(true);
          }}
          className="items-center text-content-secondary"
        />
        {externalProcessor && (
          <details open={externalDetailsOpen} onToggle={(event) => setExternalDetailsOpen(event.currentTarget.open)} className="mt-3">
            <summary className="cursor-pointer text-compact text-content-secondary">Configure provider disclosure</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Provider name"><Input value={processorName} onChange={(e) => setProcessorName(e.target.value)} placeholder="OpenAI, Anthropic, or operator name" /></Field>
              <Field label="Provider privacy URL"><Input value={processorPrivacyUrl} onChange={(e) => setProcessorPrivacyUrl(e.target.value)} placeholder="https://…" /></Field>
              <Field label="Data use shown to members" className="sm:col-span-2"><Textarea value={processorDataUse} onChange={(e) => setProcessorDataUse(e.target.value)} rows={2} placeholder="Messages and selected workspace context are sent to generate replies." /></Field>
              <Field label="Disclosure version"><Input value={processorPolicyVersion} onChange={(e) => setProcessorPolicyVersion(e.target.value)} placeholder="1" /></Field>
            </div>
            <p className="mt-3 text-compact text-content-muted">Changing the disclosure version requires members to consent again before their next AI-directed message.</p>
          </details>
        )}
      </div>

      {/* Auto-refresh — one row. The how/why is hover help; the prompt is a dialog. */}
      <div className="border-t border-zinc-800 pt-4">
        <div className="flex flex-wrap items-center gap-2">
        <CheckboxField
          label="Auto-refresh status"
          className="items-center"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
        />
        <Tip content="Asks the bot with the status prompt on a schedule (min 5 minutes) and writes the answer back. Needs the bot online." />
        {auto && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-compact text-content-muted">Every</span>
            <Input
              type="number"
              min={5}
              value={interval}
              onChange={(e) => setIntervalMin(e.target.value)}
              controlSize="compact"
              className="text-center"
              aria-label="Interval minutes"
            />
            <span className="text-compact text-content-muted">min</span>
            <Tip
              align="end"
              content={`Current prompt: “${prompt.trim() || "none set"}”. Click to edit.`}
            >
              <IconButton
                label="Edit status prompt"
                controlSize="compact"
                onClick={() => {
                  setPromptDraft(prompt);
                  setPromptOpen(true);
                }}
              >
                <Pencil className="w-3.5 h-3.5" />
              </IconButton>
            </Tip>
          </div>
        )}
        </div>

        {promptError && <p className="mt-2 text-compact text-danger-400">{promptError}</p>}
      </div>

      {refreshPhase === "timeout" && (
        <p className="text-compact text-warning-400/80 leading-heading">
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
          <p className="text-compact text-content-muted">
            The bot answers this prompt on the schedule and the reply becomes its status.
            Save the profile to apply your changes.
          </p>
          <div className="flex justify-end gap-2">
            <Button action="cancel" variant="secondary" onClick={() => setPromptOpen(false)}>
              Cancel
            </Button>
            <Button action="done"
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
    </section>
  );
}
