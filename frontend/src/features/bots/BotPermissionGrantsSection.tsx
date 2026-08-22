import { Select as UiSelect } from "@/components/ui/select";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import { Pencil, ShieldCheck, Trash2 } from "lucide-react";
import {
  getEventAccess,
  upsertEventRule,
  deleteEventRule,
  type EventAccess,
  type EventRule,
  type Capability,
  type SubjectKind,
} from "@/api/bots";
import { listChannelMembers } from "@/api/channels";
import type { MemberItem } from "@/types";
import { grantLabel, CAPABILITY_LABEL } from "./grantLabels";
import { OperationsItem } from "@/components/ui/item";
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

const ROLES = ["*", "owner", "admin", "member"] as const;
// Real channel roles shown as columns in the effective-defaults matrix (no `*`).
const MATRIX_ROLES = ["owner", "admin", "member"] as const;
const CAP_ORDER: Capability[] = ["initiate", "see", "respond"];

/**
 * Bot permission grants (docs/arch/ACP_EVENT_TAXONOMY.md) — a LIST + NEW model:
 * one flat list of every grant (permission · domain · scope · decision) so you can
 * see who's authorized at a glance and revoke any of them inline, plus a + New
 * grant form. Backed by the bot_event_access rules.
 */
export function BotPermissionGrantsSection({ botId }: { botId: string }) {
  const [access, setAccess] = useState<EventAccess | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [membersByChannel, setMembersByChannel] = useState<Record<string, MemberItem[]>>({});
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<CollectionMode>({ kind: "browse" });
  const [editing, setEditing] = useState<EventRule | null>(null);

  // new-grant draft
  const [perm, setPerm] = useState(""); // "cap::event"
  const [scope, setScope] = useState(""); // "" = bot-wide
  const [subject, setSubject] = useState(""); // "role:member" | "group:<ref>" | "user:<id>"
  const [decision, setDecision] = useState<"allow" | "deny">("allow");
  // Time-box for the new rule: seconds until expiry ("" = permanent).
  const [expiry, setExpiry] = useState("");

  const load = useCallback(async () => {
    try {
      const a = await getEventAccess(botId);
      setAccess(a);
      const chIds = a.groups
        .filter((g) => g.ref.startsWith("channel:"))
        .map((g) => g.ref.slice("channel:".length));
      const lists = await Promise.all(
        chIds.map(
          async (id) =>
            [id, (await listChannelMembers(id)).filter((m) => m.member_type === "user")] as const
        )
      );
      setMembersByChannel(Object.fromEntries(lists));
    } catch (e) {
      notify.error(messageOf(e));
    }
  }, [botId]);
  useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const nameMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const list of Object.values(membersByChannel)) {
      for (const u of list) m[u.member_id] = u.display_name || u.username || u.member_id;
    }
    return m;
  }, [membersByChannel]);

  const channelLabel = (id: string) =>
    access?.groups.find((g) => g.ref === `channel:${id}`)?.label.replace(/ members$/, "") ||
    `#${id.slice(0, 8)}`;
  const scopeLabel = (cid: string) => (cid ? channelLabel(cid) : "Bot-wide");
  const subjectLabel = (r: EventRule): string => {
    if (r.subject_kind === "role") return r.subject_id === "*" ? "∗ any role" : `${r.subject_id} (role)`;
    if (r.subject_kind === "group")
      return access?.groups.find((g) => g.ref === r.subject_id)?.label || r.subject_id;
    return nameMap[r.subject_id] || `${r.subject_id.slice(0, 8)}…`;
  };
  // All grants, sorted by capability → event → subject for a stable, scannable list.
  const grants = useMemo(() => {
    const rules = [...(access?.rules ?? [])];
    rules.sort((a, b) => {
      const ca = CAP_ORDER.indexOf(a.capability) - CAP_ORDER.indexOf(b.capability);
      if (ca !== 0) return ca;
      if (a.event_class !== b.event_class) return a.event_class.localeCompare(b.event_class);
      return a.subject_id.localeCompare(b.subject_id);
    });
    return rules;
  }, [access]);

  const scopeOptions = useMemo(() => {
    const opts = [{ val: "", label: "Bot-wide (all channels)" }];
    for (const g of access?.groups.filter((x) => x.ref.startsWith("channel:")) ?? []) {
      opts.push({ val: g.ref.slice("channel:".length), label: g.label.replace(/ members$/, "") });
    }
    return opts;
  }, [access]);

  const usersForScope = (cid: string): MemberItem[] => {
    if (cid) return membersByChannel[cid] ?? [];
    const seen = new Set<string>();
    const out: MemberItem[] = [];
    for (const list of Object.values(membersByChannel)) {
      for (const user of list) {
        if (seen.has(user.member_id)) continue;
        seen.add(user.member_id);
        out.push(user);
      }
    }
    return out;
  };

  const resetDraft = () => {
    setMode({ kind: "browse" });
    setEditing(null);
    setPerm("");
    setScope("");
    setSubject("");
    setDecision("allow");
    setExpiry("");
  };

  const visibleGrants = grants.filter((rule) => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return true;
    return `${grantLabel(rule.capability, rule.event_class).label} ${subjectLabel(rule)} ${scopeLabel(rule.channel_id)} ${rule.decision}`
      .toLocaleLowerCase()
      .includes(normalized);
  });

  const beginAdd = () => {
    resetDraft();
    setMode({ kind: "add" });
  };
  const beginEdit = (rule: EventRule) => {
    setEditing(rule);
    setPerm(`${rule.capability}::${rule.event_class}`);
    setScope(rule.channel_id);
    setSubject(`${rule.subject_kind}:${rule.subject_id}`);
    setDecision(rule.decision);
    setExpiry(rule.expires_at ? "preserve" : "");
    setMode({ kind: "edit", id: `${rule.capability}:${rule.event_class}:${rule.channel_id}:${rule.subject_kind}:${rule.subject_id}` });
  };

  const saveGrant = () => run(mode.kind === "edit" ? "edit" : "add", async () => {
    const [cap, eventClass] = perm.split("::");
    const [kind, ...subjectParts] = subject.split(":");
    await upsertEventRule(botId, {
      channel_id: scope || undefined,
      subject_kind: kind as SubjectKind,
      subject_id: subjectParts.join(":"),
      event_class: eventClass,
      capability: cap as Capability,
      decision,
      expires_at: expiry === "preserve"
        ? editing?.expires_at || undefined
        : expiry
          ? new Date(Date.now() + Number(expiry) * 1000).toISOString()
          : undefined,
    });
    resetDraft();
  });

  const removeGrant = (rule: EventRule) => run(
    `rm:${rule.capability}:${rule.event_class}:${rule.channel_id}:${rule.subject_id}`,
    async () => {
      await deleteEventRule(botId, {
        channel_id: rule.channel_id || undefined,
        subject_kind: rule.subject_kind,
        subject_id: rule.subject_id,
        event_class: rule.event_class,
        capability: rule.capability,
      });
      resetDraft();
    },
  );

  if (!access) {
    return <p className="text-compact text-content-muted px-1 py-2">Loading grants…</p>;
  }

  const editor = (editorMode: "add" | "edit", key?: string) => (
    <CollectionEditorItem
      key={key}
      mode={editorMode}
      title={editorMode === "add" ? "Add permission grant" : "Edit permission grant"}
      onCancel={resetDraft}
      onSave={() => void saveGrant()}
      saving={busy !== null}
      saveDisabled={!perm || !subject}
    >
      <Field label="Permission">
        <UiSelect value={perm} disabled={editorMode === "edit"} onChange={(event) => setPerm(event.target.value)} controlSize="regular">
          <option value="">Choose permission…</option>
          {CAP_ORDER.map((capability) => {
            const events = capability === "initiate" ? access.initiate_events : capability === "see" ? access.see_events : access.respond_events;
            return (
              <optgroup key={capability} label={CAPABILITY_LABEL[capability].label}>
                {events.map((eventClass) => <option key={`${capability}::${eventClass}`} value={`${capability}::${eventClass}`}>{grantLabel(capability, eventClass).label}</option>)}
              </optgroup>
            );
          })}
        </UiSelect>
      </Field>
      <Field label="Scope">
        <UiSelect value={scope} disabled={editorMode === "edit"} onChange={(event) => { setScope(event.target.value); setSubject(""); }} controlSize="regular">
          {scopeOptions.map((option) => <option key={option.val} value={option.val}>{option.label}</option>)}
        </UiSelect>
      </Field>
      <Field label="Subject">
        <UiSelect value={subject} disabled={editorMode === "edit"} onChange={(event) => setSubject(event.target.value)} controlSize="regular">
          <option value="">Choose subject…</option>
          <optgroup label="Roles">{ROLES.map((role) => <option key={role} value={`role:${role}`}>{role === "*" ? "∗ any role" : role}</option>)}</optgroup>
          <optgroup label="Groups">{access.groups.map((group) => <option key={group.ref} value={`group:${group.ref}`}>{group.label}</option>)}</optgroup>
          <optgroup label="Users">{usersForScope(scope).map((member) => <option key={member.member_id} value={`user:${member.member_id}`}>{member.display_name || member.username}</option>)}</optgroup>
        </UiSelect>
      </Field>
      <Field label="Decision">
        <UiSelect value={decision} onChange={(event) => setDecision(event.target.value as "allow" | "deny")} controlSize="regular">
          <option value="allow">Allow</option><option value="deny">Deny</option>
        </UiSelect>
      </Field>
      <Field label="Expiry" className="sm:col-span-2">
        <UiSelect value={expiry} onChange={(event) => setExpiry(event.target.value)} controlSize="regular">
          {editorMode === "edit" && editing?.expires_at && <option value="preserve">Keep current expiry</option>}
          <option value="">Permanent</option><option value="3600">1 hour</option><option value="28800">8 hours</option><option value="86400">1 day</option><option value="604800">7 days</option><option value="2592000">30 days</option>
        </UiSelect>
      </Field>
    </CollectionEditorItem>
  );

  return (
    <div className="space-y-3">
      <div>
        <p className="text-section-label">Permissions</p>
        <p className="mt-1 text-compact text-content-muted">Grants refine the bot-wide defaults; deny wins when rules tie.</p>
      </div>

      {/* Effective defaults (read-only): the baseline decision per event × role at
          bot-wide scope, so members-can-cancel-by-default etc. is visible, not just
          the explicit overrides below. */}
      {access.effective && access.effective.length > 0 && (
        <details className="rounded-sm bg-zinc-900 px-3 py-2">
          <summary className="cursor-pointer text-compact text-content-secondary">View bot-wide defaults</summary>
          <p className="mt-2 text-minimal text-content-muted"><span className="text-accent-400">•</span> marks a grant; channel, user, and group grants can narrow a default.</p>
          <div className="mt-2 overflow-x-auto">
          <table className="min-w-[34rem] w-full text-compact">
            <thead>
              <tr className="text-content-muted">
                <th className="px-3 py-1 text-left font-normal">Event</th>
                <th
                  className="px-2 py-1 text-center font-normal text-accent-300"
                  title="The bot owner (you). Do/Answer are always allowed — owner privilege, not revocable by grants. View follows the same rules as everyone else."
                >
                  you · bot owner
                </th>
                {MATRIX_ROLES.map((r) => (
                  <th key={r} className="px-2 py-1 text-center font-normal">
                    {r}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAP_ORDER.map((cap) => {
                const cells = access.effective.filter((c) => c.capability === cap);
                if (cells.length === 0) return null;
                return (
                  <Fragment key={cap}>
                    <tr>
                      <td
                        colSpan={2 + MATRIX_ROLES.length}
                        className="px-3 pt-2 pb-1 text-minimal uppercase tracking-section text-content-muted"
                        title={`${cap} — ${CAPABILITY_LABEL[cap].desc}`}
                      >
                        {CAPABILITY_LABEL[cap].label}
                      </td>
                    </tr>
                    {cells.map((c) => {
                      const gl = grantLabel(cap, c.event_class);
                      return (
                      <tr key={`${cap}:${c.event_class}`} className="border-t border-zinc-800/50">
                        <td className="px-3 py-1">
                          <span
                            className="text-content-secondary"
                            title={gl.desc ? `${gl.desc} (${cap} · ${c.event_class})` : `${cap} · ${c.event_class}`}
                          >
                            {gl.label}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-center">
                          {c.bot_owner ? (
                            <span
                              className={
                                c.bot_owner.source === "owner"
                                  ? "text-accent-300"
                                  : c.bot_owner.allow
                                  ? "text-success-400"
                                  : "text-content-muted"
                              }
                              title={
                                c.bot_owner.source === "owner"
                                  ? "always allowed — you own this bot"
                                  : c.bot_owner.source === "rule"
                                  ? "set by a grant (View has no owner bypass)"
                                  : "membership default (View has no owner bypass)"
                              }
                            >
                              {c.bot_owner.allow ? "✓" : "✗"}
                              {c.bot_owner.source === "rule" && (
                                <span className="text-accent-400">•</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-content-muted">—</span>
                          )}
                        </td>
                        {MATRIX_ROLES.map((role) => {
                          const d = c.roles[role];
                          if (!d) {
                            return (
                              <td key={role} className="px-2 py-1 text-center text-content-muted">
                                —
                              </td>
                            );
                          }
                          return (
                            <td key={role} className="px-2 py-1 text-center">
                              <span
                                className={d.allow ? "text-success-400" : "text-content-muted"}
                                title={d.source === "rule" ? "set by a grant" : "membership default"}
                              >
                                {d.allow ? "✓" : "✗"}
                                {d.source === "rule" && <span className="text-accent-400">•</span>}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </details>
      )}

      <CollectionManager
        label="Permission grants"
        count={grants.length}
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search permission grants"
        addLabel="Add grant"
        onAdd={beginAdd}
        addDisabled={mode.kind !== "browse"}
        presentationLevel="medium"
        controlSize="regular"
      >
        {mode.kind === "add" && editor("add")}
        {visibleGrants.map((rule) => {
          const id = `${rule.capability}:${rule.event_class}:${rule.channel_id}:${rule.subject_kind}:${rule.subject_id}`;
          if (mode.kind === "edit" && mode.id === id) return editor("edit", id);
          if (mode.kind === "delete" && mode.id === id) return (
            <CollectionDeleteItem
              key={id}
              title={`Revoke ${grantLabel(rule.capability, rule.event_class).label} grant?`}
              description="The membership default will apply again."
              onCancel={resetDraft}
              onConfirm={() => void removeGrant(rule)}
              deleting={busy !== null}
            />
          );
          return (
            <OperationsItem
              key={id}
              leading={<ShieldCheck className={controlIconClasses.regular} />}
              title={`${grantLabel(rule.capability, rule.event_class).label} → ${subjectLabel(rule)}`}
              status={<span className={rule.decision === "allow" ? "font-utility text-compact uppercase text-success-300" : "font-utility text-compact uppercase text-danger-300"}>{rule.decision}</span>}
              criticalStatus={rule.expired ? <span className="font-utility text-compact uppercase text-warning-400">Expired</span> : undefined}
              actions={(
                <>
                  <IconButton label="Edit permission grant" controlSize="compact" onClick={() => beginEdit(rule)}><Pencil className={controlIconClasses.compact} /></IconButton>
                  <IconButton label="Revoke permission grant" tone="danger" controlSize="compact" onClick={() => setMode({ kind: "delete", id })}><Trash2 className={controlIconClasses.compact} /></IconButton>
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
