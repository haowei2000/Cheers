import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { X, Plus } from "lucide-react";
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

const ROLES = ["*", "owner", "admin", "member"] as const;
// Real channel roles shown as columns in the effective-defaults matrix (no `*`).
const MATRIX_ROLES = ["owner", "admin", "member"] as const;
const CAP_ORDER: Capability[] = ["initiate", "see", "respond"];
const CAP_BADGE: Record<Capability, string> = {
  initiate: "bg-sky-950/60 border-sky-900 text-sky-200",
  see: "bg-zinc-800 border-zinc-700 text-zinc-300",
  respond: "bg-amber-950/50 border-amber-900 text-amber-200",
};

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
  const [creating, setCreating] = useState(false);

  // new-grant draft
  const [perm, setPerm] = useState(""); // "cap::event"
  const [scope, setScope] = useState(""); // "" = bot-wide
  const [subject, setSubject] = useState(""); // "role:member" | "group:<ref>" | "user:<id>"
  const [decision, setDecision] = useState<"allow" | "deny">("allow");

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
      toast.error(String(e));
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
      toast.error(String(e));
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
  const subjectBadge = (k: string) =>
    k === "group"
      ? "bg-violet-950/50 border-violet-900 text-violet-200"
      : k === "user"
      ? "bg-indigo-950/60 border-indigo-900 text-indigo-200"
      : "bg-zinc-800 border-zinc-700 text-zinc-300";

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
    for (const list of Object.values(membersByChannel))
      for (const u of list) if (!seen.has(u.member_id)) (seen.add(u.member_id), out.push(u));
    return out;
  };

  const resetDraft = () => {
    setCreating(false);
    setPerm("");
    setScope("");
    setSubject("");
    setDecision("allow");
  };

  if (!access) {
    return <p className="text-xs text-zinc-600 px-1 py-2">Loading grants…</p>;
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <div>
          <p className="text-xs font-medium text-zinc-300">Permission grants</p>
          <p className="text-[11px] text-zinc-600 mt-0.5">
            Who is authorized for what. No grant → the default (members may initiate + see;
            respond is owner-only). Precedence: user ▸ group ▸ role ▸ ∗; deny wins ties.
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
          >
            <Plus className="w-3.5 h-3.5" />
            New grant
          </button>
        )}
      </div>

      {/* Effective defaults (read-only): the baseline decision per event × role at
          bot-wide scope, so members-can-cancel-by-default etc. is visible, not just
          the explicit overrides below. */}
      {access.effective && access.effective.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-zinc-900/40">
            <p className="text-[11px] font-medium text-zinc-300">Effective defaults · Bot-wide</p>
            <span className="text-[10px] text-zinc-600">
              <span className="text-indigo-400">•</span> = set by a grant · channel / user / group
              grants can narrow this per scope
            </span>
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-zinc-500">
                <th className="px-2.5 py-1 text-left font-normal">Event</th>
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
                        colSpan={1 + MATRIX_ROLES.length}
                        className="px-2.5 pt-2 pb-0.5 text-[10px] uppercase tracking-wider text-zinc-600"
                      >
                        {cap}
                      </td>
                    </tr>
                    {cells.map((c) => (
                      <tr key={`${cap}:${c.event_class}`} className="border-t border-zinc-800/50">
                        <td className="px-2.5 py-1">
                          <code className="text-zinc-300">{c.event_class}</code>
                        </td>
                        {MATRIX_ROLES.map((role) => {
                          const d = c.roles[role];
                          if (!d) {
                            return (
                              <td key={role} className="px-2 py-1 text-center text-zinc-700">
                                —
                              </td>
                            );
                          }
                          return (
                            <td key={role} className="px-2 py-1 text-center">
                              <span
                                className={d.allow ? "text-emerald-400" : "text-zinc-600"}
                                title={d.source === "rule" ? "set by a grant" : "membership default"}
                              >
                                {d.allow ? "✓" : "✗"}
                                {d.source === "rule" && <span className="text-indigo-400">•</span>}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* New-grant form */}
      {creating && (
        <div className="rounded-lg border border-indigo-900/60 bg-indigo-950/20 p-2.5 space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-zinc-400">New grant</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={perm}
              onChange={(e) => setPerm(e.target.value)}
              className="rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              <option value="">permission…</option>
              {CAP_ORDER.map((cap) => {
                const evs =
                  cap === "initiate"
                    ? access.initiate_events
                    : cap === "see"
                    ? access.see_events
                    : access.respond_events;
                return (
                  <optgroup key={cap} label={cap}>
                    {evs.map((ec) => (
                      <option key={`${cap}::${ec}`} value={`${cap}::${ec}`}>
                        {cap} · {ec}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            <select
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setSubject("");
              }}
              className="rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              {scopeOptions.map((o) => (
                <option key={o.val} value={o.val}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              <option value="">domain…</option>
              <optgroup label="Roles">
                {ROLES.map((r) => (
                  <option key={r} value={`role:${r}`}>
                    {r === "*" ? "∗ any role" : `${r} (role)`}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Groups">
                {access.groups.map((g) => (
                  <option key={g.ref} value={`group:${g.ref}`}>
                    {g.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Users">
                {usersForScope(scope).map((m) => (
                  <option key={m.member_id} value={`user:${m.member_id}`}>
                    {m.display_name || m.username}
                  </option>
                ))}
              </optgroup>
            </select>
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as "allow" | "deny")}
              className="rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              <option value="allow">allow</option>
              <option value="deny">deny</option>
            </select>
            <button
              type="button"
              disabled={!perm || !subject || busy !== null}
              onClick={() =>
                run("add", async () => {
                  const [cap, ec] = perm.split("::");
                  const [kind, ...rest] = subject.split(":");
                  await upsertEventRule(botId, {
                    channel_id: scope || undefined,
                    subject_kind: kind as SubjectKind,
                    subject_id: rest.join(":"),
                    event_class: ec,
                    capability: cap as Capability,
                    decision,
                  });
                  resetDraft();
                })
              }
              className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Create
            </button>
            <button
              type="button"
              onClick={resetDraft}
              className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Flat grants list */}
      {grants.length === 0 ? (
        <p className="text-[11px] text-zinc-600">
          No grants yet — the bot uses the membership defaults. Click “New grant” to authorize a
          user, role, or group.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800 divide-y divide-zinc-800/70">
          {grants.map((r) => (
            <div
              key={`${r.capability}:${r.event_class}:${r.channel_id}:${r.subject_kind}:${r.subject_id}`}
              className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]"
            >
              <span className={`rounded px-1 py-0.5 text-[10px] border ${CAP_BADGE[r.capability]}`}>
                {r.capability}
              </span>
              <code className="text-zinc-300">{r.event_class}</code>
              <span className="text-zinc-600">→</span>
              <span className={`rounded px-1 py-0.5 text-[10px] border ${subjectBadge(r.subject_kind)}`}>
                {r.subject_kind}
              </span>
              <span className="text-zinc-200" title={r.subject_id}>
                {subjectLabel(r)}
              </span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400" title={r.channel_id || undefined}>
                {scopeLabel(r.channel_id)}
              </span>
              <span className={`ml-auto ${r.decision === "allow" ? "text-emerald-300" : "text-red-300"}`}>
                {r.decision}
              </span>
              <button
                type="button"
                title="Revoke this grant"
                disabled={busy !== null}
                onClick={() =>
                  run(`rm:${r.capability}:${r.event_class}:${r.channel_id}:${r.subject_id}`, () =>
                    deleteEventRule(botId, {
                      channel_id: r.channel_id || undefined,
                      subject_kind: r.subject_kind,
                      subject_id: r.subject_id,
                      event_class: r.event_class,
                      capability: r.capability,
                    })
                  )
                }
                className="text-zinc-600 hover:text-red-300 disabled:opacity-40"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
