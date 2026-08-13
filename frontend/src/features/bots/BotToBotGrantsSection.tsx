import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, ShieldCheck, Trash2 } from "lucide-react";
import { notify, messageOf } from "@/lib/notify";
import {
  getBotGrants,
  upsertBotGrant,
  deleteBotGrant,
  type BotGrants,
  type BotGrant,
  type BotGrantKind,
} from "@/api/bots";
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
import { OperationsItem } from "@/components/ui/item";
import { Select } from "@/components/ui/select";

export function BotToBotGrantsSection({ botId }: { botId: string }) {
  const [data, setData] = useState<BotGrants | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<CollectionMode>({ kind: "browse" });
  const [editing, setEditing] = useState<BotGrant | null>(null);
  const [grant, setGrant] = useState<BotGrantKind>("workspace_read");
  const [subjectId, setSubjectId] = useState("");
  const [decision, setDecision] = useState<"allow" | "deny">("deny");
  const [expiry, setExpiry] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await getBotGrants(botId));
    } catch (error) {
      notify.error(messageOf(error));
    }
  }, [botId]);

  useEffect(() => { void load(); }, [load]);

  const kindLabel = useMemo(() => Object.fromEntries(
    (data?.grant_kinds ?? []).map((kind) => [kind.kind, kind.label]),
  ) as Record<string, string>, [data]);
  const subjectLabel = useMemo(() => Object.fromEntries(
    (data?.subjects ?? []).map((subject) => [subject.bot_id, subject.label]),
  ) as Record<string, string>, [data]);
  const visibleGrants = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const grants = data?.grants ?? [];
    if (!normalized) return grants;
    return grants.filter((rule) => (
      `${kindLabel[rule.grant] ?? rule.grant} ${subjectLabel[rule.subject_id] ?? rule.subject_id} ${rule.decision}`
        .toLocaleLowerCase()
        .includes(normalized)
    ));
  }, [data, kindLabel, query, subjectLabel]);

  const reset = () => {
    setMode({ kind: "browse" });
    setEditing(null);
    setGrant("workspace_read");
    setSubjectId("");
    setDecision("deny");
    setExpiry("");
  };
  const beginAdd = () => {
    reset();
    setMode({ kind: "add" });
  };
  const beginEdit = (rule: BotGrant) => {
    setEditing(rule);
    setGrant(rule.grant);
    setSubjectId(rule.subject_id);
    setDecision(rule.decision);
    setExpiry(rule.expires_at ? "preserve" : "");
    setMode({ kind: "edit", id: `${rule.grant}:${rule.channel_id}:${rule.subject_id}` });
  };

  async function save() {
    if (!subjectId) return;
    setBusy(true);
    try {
      await upsertBotGrant(botId, {
        channel_id: editing?.channel_id || undefined,
        subject_id: subjectId,
        grant,
        decision,
        expires_at: expiry === "preserve"
          ? editing?.expires_at || undefined
          : expiry
            ? new Date(Date.now() + Number(expiry) * 1000).toISOString()
            : undefined,
      });
      await load();
      reset();
    } catch (error) {
      notify.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: BotGrant) {
    setBusy(true);
    try {
      await deleteBotGrant(botId, {
        channel_id: rule.channel_id || undefined,
        subject_id: rule.subject_id,
        grant: rule.grant,
      });
      await load();
      reset();
    } catch (error) {
      notify.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <OperationsItem title="Loading bot-to-bot grants…" />;

  const editor = (editorMode: "add" | "edit", key?: string) => (
    <CollectionEditorItem
      key={key}
      mode={editorMode}
      title={editorMode === "add" ? "Add bot-to-bot rule" : "Edit bot-to-bot rule"}
      onCancel={reset}
      onSave={() => void save()}
      saving={busy}
      saveDisabled={!subjectId}
    >
      <Field label="Permission">
        <Select controlSize="regular" value={grant} disabled={editorMode === "edit"} onChange={(event) => setGrant(event.target.value as BotGrantKind)}>
          {data.grant_kinds.map((kind) => <option key={kind.kind} value={kind.kind}>{kind.label}</option>)}
        </Select>
      </Field>
      <Field label="Bot">
        <Select controlSize="regular" value={subjectId} disabled={editorMode === "edit"} onChange={(event) => setSubjectId(event.target.value)}>
          <option value="">Choose a bot…</option>
          <option value="*">∗ any bot</option>
          {data.subjects.map((subject) => <option key={subject.bot_id} value={subject.bot_id}>{subject.label}</option>)}
        </Select>
      </Field>
      <Field label="Decision">
        <Select controlSize="regular" value={decision} onChange={(event) => setDecision(event.target.value as "allow" | "deny")}>
          <option value="deny">Deny</option>
          <option value="allow">Allow</option>
        </Select>
      </Field>
      <Field label="Expiry">
        <Select controlSize="regular" value={expiry} onChange={(event) => setExpiry(event.target.value)}>
          {editorMode === "edit" && editing?.expires_at && <option value="preserve">Keep current expiry</option>}
          <option value="">Permanent</option>
          <option value="3600">1 hour</option>
          <option value="28800">8 hours</option>
          <option value="86400">1 day</option>
          <option value="604800">7 days</option>
          <option value="2592000">30 days</option>
        </Select>
      </Field>
    </CollectionEditorItem>
  );

  return (
    <div className="space-y-2">
      <p className="font-utility text-compact text-zinc-400">
        Control which other bots may command this bot or read its workspace. Specific rules override the shared-channel default.
      </p>
      <CollectionManager
        label="Bot-to-bot grants"
        count={data.grants.length}
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search bot grants"
        addLabel="Add rule"
        onAdd={beginAdd}
        addDisabled={mode.kind !== "browse"}
        presentationLevel="medium"
        controlSize="regular"
      >
        {mode.kind === "add" && editor("add")}
        {visibleGrants.map((rule) => {
          const id = `${rule.grant}:${rule.channel_id}:${rule.subject_id}`;
          if (mode.kind === "edit" && mode.id === id) return editor("edit", id);
          if (mode.kind === "delete" && mode.id === id) return (
            <CollectionDeleteItem
              key={id}
              title={`Remove ${kindLabel[rule.grant] ?? rule.grant} rule?`}
              description="The shared-channel default will apply again."
              onCancel={reset}
              onConfirm={() => void remove(rule)}
              deleting={busy}
            />
          );
          return (
            <OperationsItem
              key={id}
              leading={<ShieldCheck className={controlIconClasses.regular} />}
              title={`${kindLabel[rule.grant] ?? rule.grant} → ${rule.subject_id === "*" ? "any bot" : subjectLabel[rule.subject_id] || `${rule.subject_id.slice(0, 8)}…`}`}
              status={<span className={rule.decision === "allow" ? "font-utility text-compact uppercase text-emerald-300" : "font-utility text-compact uppercase text-red-300"}>{rule.decision}</span>}
              criticalStatus={rule.expired ? <span className="font-utility text-compact uppercase text-amber-400">Expired</span> : undefined}
              actions={(
                <>
                  <IconButton label="Edit bot grant" controlSize="compact" onClick={() => beginEdit(rule)}><Pencil className={controlIconClasses.compact} /></IconButton>
                  <IconButton label="Remove bot grant" tone="danger" controlSize="compact" onClick={() => setMode({ kind: "delete", id })}><Trash2 className={controlIconClasses.compact} /></IconButton>
                </>
              )}
            />
          );
        })}
        {visibleGrants.length === 0 && mode.kind !== "add" && <CollectionEmptyItem query={query} onClear={() => setQuery("")} />}
      </CollectionManager>
    </div>
  );
}
