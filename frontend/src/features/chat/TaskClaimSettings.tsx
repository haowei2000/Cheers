import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Pencil, Radio, Trash2 } from "lucide-react";
import { getBotMonitoring, updateBotMonitoring, type BotMonitoring } from "@/api/taskClaims";
import {
  CollectionDeleteItem,
  CollectionEditorItem,
  CollectionEmptyItem,
  CollectionManager,
  type CollectionMode,
} from "@/components/ui/collection-manager";
import { controlIconClasses } from "@/components/ui/control-size";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { OperationsItem } from "@/components/ui/item";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { MemberItem } from "@/types";

type ClaimPolicy = Omit<BotMonitoring, "channel_id" | "bot_id">;

const defaults: ClaimPolicy = {
  mode: "off",
  scope: "",
  debounce_seconds: 15,
  min_interval_seconds: 60,
  max_evaluations_per_hour: 20,
  batch_size: 8,
  confidence_threshold: 0.75,
};

const createDefaults: ClaimPolicy = { ...defaults, mode: "text" };

function botName(bot: MemberItem): string {
  return bot.display_name || bot.username || bot.member_id.slice(0, 8);
}

function modeLabel(mode: ClaimPolicy["mode"]): string {
  switch (mode) {
    case "text": return "Text";
    case "text_and_transcript": return "Text + voice";
    case "all_activity": return "All activity";
    default: return "Off";
  }
}

export function TaskClaimSettings({
  channelId,
  bots,
}: {
  channelId: string;
  bots: MemberItem[];
}) {
  const [policies, setPolicies] = useState<Record<string, ClaimPolicy>>({});
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<CollectionMode>({ kind: "browse" });
  const [draftBotId, setDraftBotId] = useState("");
  const [draft, setDraft] = useState<ClaimPolicy>(createDefaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all(bots.map(async (bot) => {
      try {
        const { channel_id: _, bot_id: __, ...policy } = await getBotMonitoring(channelId, bot.member_id);
        return [bot.member_id, policy] as const;
      } catch {
        return [bot.member_id, defaults] as const;
      }
    })).then((entries) => {
      if (!cancelled) setPolicies(Object.fromEntries(entries));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [bots, channelId]);

  const configuredBots = useMemo(
    () => bots.filter((bot) => policies[bot.member_id]?.mode && policies[bot.member_id].mode !== "off"),
    [bots, policies],
  );
  const availableBots = useMemo(
    () => bots.filter((bot) => !policies[bot.member_id] || policies[bot.member_id].mode === "off"),
    [bots, policies],
  );
  const visibleBots = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return configuredBots;
    return configuredBots.filter((bot) => {
      const policy = policies[bot.member_id];
      return `${botName(bot)} ${policy?.mode ?? ""} ${policy?.scope ?? ""}`.toLocaleLowerCase().includes(normalized);
    });
  }, [configuredBots, policies, query]);

  if (!bots.length) return null;

  const cancel = () => setMode({ kind: "browse" });
  const beginAdd = () => {
    const bot = availableBots[0];
    if (!bot) return;
    setDraftBotId(bot.member_id);
    setDraft(createDefaults);
    setMode({ kind: "add" });
  };
  const beginEdit = (bot: MemberItem) => {
    setDraftBotId(bot.member_id);
    setDraft(policies[bot.member_id] ?? createDefaults);
    setMode({ kind: "edit", id: bot.member_id });
  };
  const save = async () => {
    const botId = mode.kind === "edit" ? mode.id : draftBotId;
    if (!botId) return;
    setSaving(true);
    try {
      const { channel_id: _, bot_id: __, ...saved } = await updateBotMonitoring(channelId, botId, draft);
      setPolicies((current) => ({ ...current, [botId]: saved }));
      setMode({ kind: "browse" });
      toast.success(mode.kind === "add" ? "Claim policy added" : "Claim policy saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save claim policy");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (botId: string) => {
    setSaving(true);
    try {
      const { channel_id: _, bot_id: __, ...saved } = await updateBotMonitoring(channelId, botId, defaults);
      setPolicies((current) => ({ ...current, [botId]: saved }));
      setMode({ kind: "browse" });
      toast.success("Claim policy removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove claim policy");
    } finally {
      setSaving(false);
    }
  };

  const editorBot = bots.find((bot) => bot.member_id === draftBotId);
  const editor = (editorMode: "add" | "edit", key?: string) => (
    <CollectionEditorItem
      key={key}
      mode={editorMode}
      title={editorMode === "add" ? "Add claim policy" : `Edit ${editorBot ? botName(editorBot) : "claim policy"}`}
      onCancel={cancel}
      onSave={() => void save()}
      saveLabel={editorMode === "add" ? "Add policy" : "Save changes"}
      saving={saving}
      saveDisabled={!draftBotId || draft.mode === "off"}
    >
      <Field label="Bot">
        <Select
          controlSize="regular"
          value={draftBotId}
          disabled={editorMode === "edit"}
          onChange={(event) => setDraftBotId(event.target.value)}
        >
          {(editorMode === "add" ? availableBots : bots.filter((bot) => bot.member_id === draftBotId)).map((bot) => (
            <option key={bot.member_id} value={bot.member_id}>{botName(bot)}</option>
          ))}
        </Select>
      </Field>
      <Field label="Listen to">
        <Select
          controlSize="regular"
          value={draft.mode}
          onChange={(event) => setDraft({ ...draft, mode: event.target.value as ClaimPolicy["mode"] })}
        >
          <option value="text">Text messages</option>
          <option value="text_and_transcript">Text + voice transcript</option>
          <option value="all_activity">All activity</option>
        </Select>
      </Field>
      <Field label="Debounce (seconds)">
        <Input
          type="number"
          min={1}
          max={3600}
          value={draft.debounce_seconds}
          onChange={(event) => setDraft({ ...draft, debounce_seconds: Number(event.target.value) })}
        />
      </Field>
      <Field label="Minimum interval">
        <Input
          type="number"
          min={1}
          value={draft.min_interval_seconds}
          onChange={(event) => setDraft({ ...draft, min_interval_seconds: Number(event.target.value) })}
        />
      </Field>
      <Field label="Checks per hour">
        <Input
          type="number"
          min={1}
          max={1000}
          value={draft.max_evaluations_per_hour}
          onChange={(event) => setDraft({ ...draft, max_evaluations_per_hour: Number(event.target.value) })}
        />
      </Field>
      <Field label="Responsibility scope" className="sm:col-span-2">
        <Textarea
          rows={2}
          value={draft.scope}
          placeholder="Frontend implementation, UI bugs, and accessibility"
          onChange={(event) => setDraft({ ...draft, scope: event.target.value })}
        />
      </Field>
    </CollectionEditorItem>
  );

  return (
    <section className="border-t border-zinc-800 pt-3">
      <CollectionManager
        label="Claims"
        count={configuredBots.length}
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search claim policies"
        addLabel="Add claim"
        onAdd={beginAdd}
        addDisabled={loading || mode.kind !== "browse" || availableBots.length === 0}
      >
        {mode.kind === "add" && editor("add")}
        {loading ? (
          <OperationsItem presentationLevel="medium" controlSize="regular" title="Loading claim policies…" />
        ) : visibleBots.map((bot) => {
          const policy = policies[bot.member_id] ?? defaults;
          if (mode.kind === "edit" && mode.id === bot.member_id) return editor("edit", bot.member_id);
          if (mode.kind === "delete" && mode.id === bot.member_id) return (
            <CollectionDeleteItem
              key={bot.member_id}
              title={`Remove ${botName(bot)} claim policy?`}
              description="Monitoring will be reset to Off."
              onCancel={cancel}
              onConfirm={() => void remove(bot.member_id)}
              deleting={saving}
            />
          );
          return (
            <OperationsItem
              key={bot.member_id}
              presentationLevel="medium"
              controlSize="regular"
              leading={<Radio className={controlIconClasses.regular} />}
              title={botName(bot)}
              status={<span className="font-utility text-compact uppercase tracking-wide text-zinc-500">{modeLabel(policy.mode)}</span>}
              actions={(
                <>
                  <IconButton label={`Edit ${botName(bot)} claim policy`} controlSize="compact" onClick={() => beginEdit(bot)}>
                    <Pencil className={controlIconClasses.compact} />
                  </IconButton>
                  <IconButton label={`Remove ${botName(bot)} claim policy`} tone="danger" controlSize="compact" onClick={() => setMode({ kind: "delete", id: bot.member_id })}>
                    <Trash2 className={controlIconClasses.compact} />
                  </IconButton>
                </>
              )}
            />
          );
        })}
        {!loading && visibleBots.length === 0 && mode.kind !== "add" && (
          <CollectionEmptyItem
            query={query}
            onClear={() => setQuery("")}
          />
        )}
      </CollectionManager>
    </section>
  );
}
