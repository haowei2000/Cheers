import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Globe, Lock, Radio, Shield, UserCheck, UserPlus, Users } from "lucide-react";
import { listBots, getBotSocialPolicy, updateBotSocialPolicy, type BotSocialPolicy } from "@/api/bots";
import { listApprovers, revokeApprover, type ApproverInfo } from "@/api/approval";
import type { BotItem } from "@/types";
import { PageLayout } from "@/components/ui/page-layout";
import { AsyncContent } from "@/components/ui/async-content";
import { Avatar } from "@/components/ui/avatar";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-button";
import { CollectionManager, CollectionConfirmationItem, CollectionEmptyItem } from "@/components/ui/collection-manager";
import { EntityItem, ItemList, OperationsItem } from "@/components/ui/item";
import { InlineEditActions } from "@/components/ui/inline-edit-actions";
import { SectionNav } from "@/components/ui/section-nav";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import { SettingsCard, SettingsCardSection, SettingsSection } from "@/components/ui/settings-card";
import { BotPostureSection } from "@/features/bots/BotPostureSection";
import { BotPermissionGrantsSection } from "@/features/bots/BotPermissionGrantsSection";

const sections = [{ id: "social", label: "Social", icon: Users }, { id: "operational", label: "Operational", icon: Shield }] as const;
export default function PermissionsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const botId = params.get("botId");
  const tab = params.get("tab") === "operational" ? "operational" : "social";
  const [bots, setBots] = useState<BotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const value = await listBots();
      if (id !== request.current) return;
      setBots(value.filter(bot => bot.can_manage)); setError(null);
    } catch (error) { if (id === request.current) setError(error instanceof Error ? error.message : "Couldn't load bots"); }
    finally { if (id === request.current) setLoading(false); }
  }, []);
  useEffect(() => { const counter = request; void load(); return () => { ++counter.current; }; }, [load]);
  const [socialBotIds, setSocialBotIds] = useState<string[]>([]);
  const selected = bots.find(bot => bot.bot_id === botId) ?? bots[0];
  useEffect(() => {
    if (selected && selected.bot_id !== botId) setParams(current => { const next = new URLSearchParams(current); next.set("botId", selected.bot_id); return next; }, { replace: true });
  }, [selected, botId, setParams]);
  const selectedSocialId = tab === "social" ? selected?.bot_id : undefined;
  useEffect(() => {
    if (selectedSocialId) setSocialBotIds(ids => ids.includes(selectedSocialId) ? ids : [...ids, selectedSocialId]);
  }, [selectedSocialId]);
  const mountedSocialIds = [...new Set([...socialBotIds, ...(selectedSocialId ? [selectedSocialId] : [])])];
  function selectParam(key: string, value: string) { setParams(current => { const next = new URLSearchParams(current); next.set(key, value); return next; }); }
  return <PageLayout title="Permissions" icon={Shield} description="Social discovery and operational approvals for your bots" navigation={
    <SectionNav ariaLabel="Permission sections" items={[...sections]} selected={tab} onSelect={id => selectParam("tab", id)} />
  }>
    <AsyncContent loading={loading} error={error} onRetry={() => void load()}>
      {!selected ? <SettingsSection title="Bots" icon={Users}>
        <p className="mb-4 font-utility text-regular text-content-muted">Create a bot in Fleet or ask its owner for management access.</p>
        <Button action="open" variant="secondary" onClick={() => navigate("/fleet")} aria-label="Open Fleet" />
      </SettingsSection> : <SettingsSection title={tab === "social" ? "Social permissions" : "Operational permissions"} icon={Shield}>
        <SettingsCard title="Bot" description="Select the bot whose permissions you want to manage.">
          <Field label="Bot" htmlFor="permissions-bot"><Select id="permissions-bot" value={selected.bot_id} onChange={event => selectParam("botId", event.target.value)}>
            {bots.map(bot => <option key={bot.bot_id} value={bot.bot_id}>{bot.display_name || bot.username}</option>)}
          </Select></Field>
          <ItemList presentationLevel="medium" controlSize="regular" className="mt-3">
            <EntityItem title={selected.display_name || selected.username} leading={<Avatar name={selected.display_name || selected.username} src={selected.avatar_url} size="regular" />} actions={<ActionButton action="open" context="settings" accessibleLabel="Open bot in Fleet" onClick={() => navigate(`/fleet/bots/${selected.bot_id}`)} />} />
          </ItemList>
          <div className="mt-4">
            {mountedSocialIds.map(id => <SocialPermissionsTab key={id} botId={id} hidden={tab !== "social" || id !== selected.bot_id} />)}
            {tab === "operational" && <OperationalPermissionsTab key={selected.bot_id} botId={selected.bot_id} />}
          </div>
        </SettingsCard>
      </SettingsSection>}
    </AsyncContent>
  </PageLayout>;
}

function SocialPermissionsTab({ botId, hidden }: { botId: string; hidden: boolean }) {
  const [saved, setSaved] = useState<BotSocialPolicy | null>(null);
  const [draft, setDraft] = useState<BotSocialPolicy | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try { const value = await getBotSocialPolicy(botId); setSaved(value); setDraft(value); setError(null); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn't load social policy"); }
    finally { setLoading(false); }
  }, [botId]);
  useEffect(() => { void load(); }, [load]);
  async function save() {
    if (!draft || saving) return;
    setSaving(true); setSaveError(null);
    try { const value = await updateBotSocialPolicy(botId, { visibility: draft.visibility, friend_policy: draft.friend_policy, invite_policy: draft.invite_policy }); setSaved(value); setDraft(value); setEditing(false); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Couldn't save social policy"); }
    finally { setSaving(false); }
  }
  return <div hidden={hidden}><AsyncContent loading={loading} error={error} onRetry={() => void load()}>
    {draft && <SettingsCardSection title="Social policy" actions={<InlineEditActions label="social policy" editing={editing} saving={saving} onEdit={() => setEditing(true)} onSave={() => void save()} onCancel={() => { setDraft(saved); setEditing(false); setSaveError(null); }} />}>
      {saveError && <Banner severity="error">{saveError}</Banner>}
      {editing ? <div className="space-y-4">
        <Field label="Discovery" hint="Choose who can find this bot in search."><ChoiceGroup ariaLabel="Bot discovery" disabled={saving} value={draft.visibility} onChange={visibility => setDraft({ ...draft, visibility })} className="sm:grid-cols-3" options={[
          { value: "public", label: "Public", leading: <Globe /> }, { value: "friends", label: "Friends", leading: <Users /> }, { value: "private", label: "Private", leading: <Lock /> },
        ]} /></Field>
        <Field label="Friend requests"><ChoiceGroup ariaLabel="Friend request policy" disabled={saving} value={draft.friend_policy} onChange={friend_policy => setDraft({ ...draft, friend_policy })} className="sm:grid-cols-3" options={[
          { value: "open", label: "Open", leading: <UserPlus /> }, { value: "require_approval", label: "Approval", leading: <UserCheck /> }, { value: "disabled", label: "Disabled", leading: <Lock /> },
        ]} /></Field>
        <Field label="Channel invitations"><ChoiceGroup ariaLabel="Channel invitation policy" disabled={saving} value={draft.invite_policy} onChange={invite_policy => setDraft({ ...draft, invite_policy })} options={[
          { value: "open", label: "Direct", leading: <UserPlus /> }, { value: "require_approval", label: "Approval", leading: <Shield /> },
        ]} /></Field>
      </div> : <ItemList presentationLevel="medium" controlSize="regular">
        <OperationsItem title="Discovery" status={draft.visibility} />
        <OperationsItem title="Friend requests" status={draft.friend_policy.replaceAll("_", " ")} />
        <OperationsItem title="Channel invitations" status={draft.invite_policy.replaceAll("_", " ")} />
      </ItemList>}
    </SettingsCardSection>}
  </AsyncContent></div>;
}

const delegateKey = (item: ApproverInfo) => `${item.user_id}:${item.channel_id}:${item.operation_kind}`;
function OperationalPermissionsTab({ botId }: { botId: string }) {
  const [approvers, setApprovers] = useState<ApproverInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const value = await listApprovers(botId); setApprovers(value.delegates || []); setError(null); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn't load delegates"); }
    finally { setLoading(false); }
  }, [botId]);
  useEffect(() => { void load(); }, [load]);
  async function revoke(item: ApproverInfo) {
    if (!item.channel_id || busy) return;
    setBusy(true); setActionError(null);
    try {
      await revokeApprover(botId, item.channel_id, item.user_id, item.operation_kind || "*");
      setApprovers(items => items.filter(current => delegateKey(current) !== delegateKey(item))); setTarget(null);
    } catch (error) { setActionError(error instanceof Error ? error.message : "Couldn't revoke delegation"); }
    finally { setBusy(false); }
  }
  const visible = approvers.filter(item => [item.display_name, item.username, item.channel_name, item.operation_kind].some(value => value?.toLowerCase().includes(query.toLowerCase())));
  return <>
    <SettingsCardSection title="Execution posture" icon={Radio} description="Agent security and approval mode."><BotPostureSection botId={botId} /></SettingsCardSection>
    <SettingsCardSection title="Approval delegations" icon={Shield} description="Collaborators allowed to approve tools in specific channels.">
      {actionError && <Banner severity="error">{actionError}</Banner>}
      <AsyncContent loading={loading} error={error} onRetry={() => void load()}>
        <CollectionManager label="Delegates" count={approvers.length} query={query} onQueryChange={setQuery} searchPlaceholder="Search delegates" showAdd={false} searchDisabled={target !== null}>
          {visible.map(item => target === delegateKey(item) ? <CollectionConfirmationItem key={delegateKey(item)} title={item.display_name || item.username || item.user_id} description="This collaborator will no longer approve tools for this channel." action="revoke" prompt="Revoke?" busy={busy} onCancel={() => { setTarget(null); setActionError(null); }} onConfirm={() => void revoke(item)} /> : <OperationsItem key={delegateKey(item)} title={item.display_name || item.username || item.user_id} leading={<Avatar name={item.display_name || item.username || item.user_id} size="regular" />} status={<span className="max-w-40 truncate text-compact text-content-muted" title={`${item.channel_name || item.channel_id} · ${item.operation_kind || "All operations"}`}>{item.channel_name || item.channel_id}</span>} actions={item.channel_id ? <ActionButton action="revoke" context="security" accessibleLabel={`Revoke delegation for ${item.display_name || item.username || item.user_id}`} disabled={target !== null} onClick={() => { setTarget(delegateKey(item)); setActionError(null); }} /> : undefined} />)}
          {!visible.length && <CollectionEmptyItem query={query} onClear={() => setQuery("")} />}
        </CollectionManager>
      </AsyncContent>
    </SettingsCardSection>
    <SettingsCardSection title="Event access" icon={Lock} description="Channel-specific access grants."><BotPermissionGrantsSection botId={botId} /></SettingsCardSection>
  </>;
}
