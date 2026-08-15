import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, CirclePause, CirclePlay, History, Pencil, Plus, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { listChannels, listChannelMembers } from "@/api/channels";
import {
  createScheduledMessage,
  deleteScheduledMessage,
  listScheduledMessageRuns,
  listScheduledMessages,
  runScheduledMessageNow,
  updateScheduledMessage,
  type ScheduledMessage,
  type ScheduledMessageInput,
  type ScheduledMessageRun,
} from "@/api/scheduledMessages";
import { Button as UiButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, SectionHead } from "@/components/ui/field";
import { Input as UiInput } from "@/components/ui/input";
import { ItemSection, WorkbenchItem } from "@/components/ui/item";
import { Select as UiSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { listExtensions, type ExtensionSummary } from "@/features/chat/workbench/extensions/api";
import { parseExtensionPackage, type AutomationContribution } from "@/features/chat/workbench/extensions/package";
import { listPersonalExtensions } from "@/lib/desktop";
import { isTauri } from "@/lib/serverConfig";
import type { Channel, MemberItem } from "@/types";

interface TemplateOption {
  extensionId: string;
  extensionTitle: string;
  automation: AutomationContribution;
}

interface FormState {
  id?: string;
  title: string;
  channelId: string;
  botId: string;
  content: string;
  kind: "once" | "interval" | "daily";
  runAt: string;
  everyMinutes: number;
  localTime: string;
  timezone: string;
  enabled: boolean;
  sourceExtensionId?: string;
  sourceAutomationId?: string;
}

function localInput(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function emptyForm(): FormState {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    title: "",
    channelId: "",
    botId: "",
    content: "",
    kind: "daily",
    runAt: localInput(new Date(Date.now() + 60 * 60_000)),
    everyMinutes: 1440,
    localTime: "09:00",
    timezone,
    enabled: true,
  };
}

export function toInput(form: FormState): ScheduledMessageInput {
  return {
    title: form.title,
    channelId: form.channelId,
    content: form.content,
    mentionIds: form.botId ? [form.botId] : [],
    schedule: form.kind === "once"
      ? { kind: "once", runAt: new Date(form.runAt).toISOString() }
      : form.kind === "interval" ? {
          kind: "interval",
          everyMinutes: form.everyMinutes,
          startAt: form.enabled ? new Date(Date.now() + form.everyMinutes * 60_000).toISOString() : undefined,
        } : { kind: "daily", localTime: form.localTime, timezone: form.timezone },
    enabled: form.enabled,
    sourceExtensionId: form.sourceExtensionId,
    sourceAutomationId: form.sourceAutomationId,
  };
}

function editForm(task: ScheduledMessage): FormState {
  return {
    id: task.id,
    title: task.title,
    channelId: task.channelId,
    botId: task.mentionIds[0] ?? "",
    content: task.content,
    kind: task.schedule.kind,
    runAt: localInput(new Date(task.schedule.runAt ?? Date.now() + 60 * 60_000)),
    everyMinutes: task.schedule.everyMinutes ?? 1440,
    localTime: task.schedule.localTime ?? "09:00",
    timezone: task.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    enabled: task.enabled,
    sourceExtensionId: task.sourceExtensionId,
    sourceAutomationId: task.sourceAutomationId,
  };
}

export function scheduleLabel(task: ScheduledMessage): string {
  if (task.schedule.kind === "once" && !task.nextRunAt && task.lastRunAt) return task.lastError ? "Failed" : "Completed";
  if (!task.enabled) return task.lastError ? "Failed" : "Paused";
  if (!task.nextRunAt) return "Completed";
  const cadence = task.schedule.kind === "interval"
    ? `Every ${task.schedule.everyMinutes} min`
    : task.schedule.kind === "daily"
      ? `Daily ${task.schedule.localTime} · ${task.schedule.timezone}`
      : "Once";
  return `${cadence} · Next ${new Date(task.nextRunAt).toLocaleString()}`;
}

export function ScheduledMessagesManager() {
  const [tasks, setTasks] = useState<ScheduledMessage[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([]);
  const [personalTemplates, setPersonalTemplates] = useState<TemplateOption[]>([]);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<{ task: ScheduledMessage; runs: ScheduledMessageRun[] } | null>(null);

  const reload = useCallback(async () => {
    const [nextTasks, nextChannels, nextExtensions, nextPersonal] = await Promise.all([
      listScheduledMessages(),
      listChannels(),
      listExtensions().catch(() => []),
      isTauri()
        ? listPersonalExtensions().then(async (stored) => Promise.all(stored.map(async (entry) => {
            const extension = await parseExtensionPackage(fromBase64(entry.contentBase64), "personal");
            return (extension.manifest.contributes.automations ?? []).map((automation) => ({
              extensionId: extension.manifest.id,
              extensionTitle: `${extension.manifest.title} (This Mac)`,
              automation,
            }));
          }))).then((groups) => groups.flat()).catch(() => [])
        : Promise.resolve([]),
    ]);
    setTasks(nextTasks);
    setChannels(nextChannels.filter((channel) => channel.is_member !== false && channel.kind !== "voice"));
    setExtensions(nextExtensions);
    setPersonalTemplates(nextPersonal);
  }, []);

  useEffect(() => { void reload().catch((error) => toast.error(String(error))); }, [reload]);
  useEffect(() => {
    if (!form?.channelId) { setMembers([]); return; }
    void listChannelMembers(form.channelId)
      .then(setMembers)
      .catch((error) => toast.error(String(error)));
  }, [form?.channelId]);

  const templates = useMemo<TemplateOption[]>(() => [
    ...extensions.flatMap((extension) => extension.automations.map((automation) => ({
      extensionId: extension.id,
      extensionTitle: extension.title,
      automation,
    }))),
    ...personalTemplates,
  ], [extensions, personalTemplates]);
  const bots = members.filter((member) => member.member_type === "bot" && member.status !== "pending");
  const timezoneOptions = useMemo(() => Array.from(new Set([
    form?.timezone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "UTC",
    "Europe/Berlin",
    "America/New_York",
    "America/Los_Angeles",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Australia/Sydney",
  ].filter((value): value is string => Boolean(value)))), [form?.timezone]);

  const save = async () => {
    if (!form) return;
    if (!form.channelId || !form.title.trim() || !form.content.trim()) {
      toast.error("Title, channel, and message are required");
      return;
    }
    setSaving(true);
    try {
      if (form.id) await updateScheduledMessage(form.id, toInput(form));
      else await createScheduledMessage(toInput(form));
      setForm(null);
      await reload();
      toast.success(form.id ? "Scheduled task updated" : "Scheduled task created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (task: ScheduledMessage) => {
    const next = editForm(task);
    next.enabled = !task.enabled;
    try {
      await updateScheduledMessage(task.id, toInput(next));
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section>
      <SectionHead icon={CalendarClock} className="mb-4">Scheduled tasks</SectionHead>
      <ItemSection
        label="Channel messages"
        presentationLevel="max"
        controlSize="regular"
        className="border-t border-zinc-800 pt-2"
        action={<UiButton action="create" content="iconText" variant="plain" controlSize="compact" onClick={() => setForm(emptyForm())}><Plus className="h-3.5 w-3.5" /> New task</UiButton>}
      >
        {tasks.map((task) => (
          <WorkbenchItem
            key={task.id}
            title={task.title}
            subtitle={`#${task.channelName}`}
            preview={task.content}
            status={<span className={task.lastError ? "text-red-400" : "text-zinc-400"}>{scheduleLabel(task)}</span>}
            metadata={task.sourceExtensionId ? `Extension: ${task.sourceExtensionId}:${task.sourceAutomationId}` : undefined}
            actions={<>
              <UiButton action="start" content="icon" variant="plain" title="Run now" aria-label={`Run ${task.title} now`} onClick={async () => { try { await runScheduledMessageNow(task.id); toast.success("Message sent"); await reload(); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } }}><CirclePlay className="h-3.5 w-3.5" /></UiButton>
              <UiButton action="review" content="icon" variant="plain" title="Run history" aria-label={`Run history for ${task.title}`} onClick={async () => { try { setHistory({ task, runs: await listScheduledMessageRuns(task.id) }); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } }}><History className="h-3.5 w-3.5" /></UiButton>
              {!(task.schedule.kind === "once" && !task.nextRunAt && task.lastRunAt) && <UiButton action={task.enabled ? "disable" : "enable"} content="icon" variant="plain" title={task.enabled ? "Pause" : "Resume"} aria-label={`${task.enabled ? "Pause" : "Resume"} ${task.title}`} onClick={() => void toggle(task)}>{task.enabled ? <CirclePause className="h-3.5 w-3.5" /> : <CirclePlay className="h-3.5 w-3.5" />}</UiButton>}
              <UiButton action="edit" content="icon" variant="plain" title="Edit" aria-label={`Edit ${task.title}`} onClick={() => setForm(editForm(task))}><Pencil className="h-3.5 w-3.5" /></UiButton>
              <UiButton action="delete" content="icon" variant="plain" title="Delete" aria-label={`Delete ${task.title}`} className="hover:text-red-400" onClick={async () => { if (!window.confirm(`Delete "${task.title}"?`)) return; await deleteScheduledMessage(task.id); await reload(); }}><Trash2 className="h-3.5 w-3.5" /></UiButton>
            </>}
          />
        ))}
        {tasks.length === 0 && <WorkbenchItem title="No scheduled tasks" />}
      </ItemSection>

      {form && <Dialog title={form.id ? "Edit scheduled task" : "New scheduled task"} onClose={() => setForm(null)} maxWidth="max-w-lg">
        <div className="space-y-4 p-5">
          {!form.id && templates.length > 0 && <Field label="Extension template">
            <UiSelect defaultValue="" onChange={(event) => {
              const template = templates.find((item) => `${item.extensionId}:${item.automation.id}` === event.target.value);
              if (!template) return;
              setForm((current) => current && ({
                ...current,
                title: template.automation.title,
                content: template.automation.message,
                kind: template.automation.defaultSchedule.kind,
                everyMinutes: template.automation.defaultSchedule.kind === "interval" ? template.automation.defaultSchedule.everyMinutes : current.everyMinutes,
                localTime: template.automation.defaultSchedule.kind === "daily" ? template.automation.defaultSchedule.localTime : current.localTime,
                timezone: template.automation.defaultSchedule.kind === "daily" ? template.automation.defaultSchedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC" : current.timezone,
                sourceExtensionId: template.extensionId,
                sourceAutomationId: template.automation.id,
              }));
            }}>
              <option value="">Blank task</option>
              {templates.map((template) => <option key={`${template.extensionId}:${template.automation.id}`} value={`${template.extensionId}:${template.automation.id}`}>{template.extensionTitle} · {template.automation.title}</option>)}
            </UiSelect>
          </Field>}
          <Field label="Title" htmlFor="scheduled-title"><UiInput id="scheduled-title" value={form.title} maxLength={120} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field>
          <Field label="Channel" htmlFor="scheduled-channel"><UiSelect id="scheduled-channel" value={form.channelId} onChange={(event) => setForm({ ...form, channelId: event.target.value, botId: "" })}><option value="">Select channel</option>{channels.map((channel) => <option key={channel.channel_id} value={channel.channel_id}>{channel.name}</option>)}</UiSelect></Field>
          <Field label="Bot" htmlFor="scheduled-bot" hint="Optional. Selecting a bot mentions it and starts its normal channel workflow."><UiSelect id="scheduled-bot" value={form.botId} disabled={!form.channelId} onChange={(event) => setForm({ ...form, botId: event.target.value })}><option value="">No bot mention</option>{bots.map((bot) => <option key={bot.member_id} value={bot.member_id}>{bot.display_name || bot.username || bot.member_id}</option>)}</UiSelect></Field>
          <Field label="Message" htmlFor="scheduled-content"><Textarea id="scheduled-content" rows={6} maxLength={4000} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <Field label="Schedule"><UiSelect value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as FormState["kind"] })}><option value="daily">Daily</option><option value="interval">Interval</option><option value="once">Once</option></UiSelect></Field>
            {form.kind === "once"
              ? <Field label="Run at"><UiInput type="datetime-local" value={form.runAt} onChange={(event) => setForm({ ...form, runAt: event.target.value })} /></Field>
              : form.kind === "interval"
                ? <Field label="Every minutes"><UiInput type="number" min={5} max={10080} value={form.everyMinutes} onChange={(event) => setForm({ ...form, everyMinutes: Number(event.target.value) })} /></Field>
                : <Field label="Local time"><UiInput type="time" value={form.localTime} onChange={(event) => setForm({ ...form, localTime: event.target.value })} /></Field>}
          </div>
          {form.kind === "daily" && <Field label="Timezone"><UiSelect value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}>{timezoneOptions.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}</UiSelect></Field>}
          <div className="flex justify-end gap-2 pt-2">
            <UiButton action="cancel" variant="plain" onClick={() => setForm(null)}>Cancel</UiButton>
            <UiButton action="save" variant="primary" loading={saving} onClick={() => void save()}>Save</UiButton>
          </div>
        </div>
      </Dialog>}

      {history && <Dialog title={`${history.task.title} · Run history`} onClose={() => setHistory(null)} maxWidth="max-w-lg">
        <div className="p-5">
          <ItemSection label="Recent runs" presentationLevel="max" controlSize="regular">
            {history.runs.map((run) => <WorkbenchItem
              key={run.id}
              title={run.status === "succeeded" ? "Message sent" : run.status === "failed" ? "Run failed" : "Running"}
              subtitle={`${run.trigger === "manual" ? "Manual" : "Scheduled"} · ${new Date(run.scheduledFor).toLocaleString()}`}
              metadata={run.messageId ? `Message ${run.messageId}` : undefined}
              preview={run.error ?? undefined}
              status={<span className={run.status === "failed" ? "text-red-400" : run.status === "succeeded" ? "text-emerald-400" : "text-amber-400"}>{run.status}</span>}
            />)}
            {history.runs.length === 0 && <WorkbenchItem title="No runs yet" />}
          </ItemSection>
        </div>
      </Dialog>}
    </section>
  );
}
