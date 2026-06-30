import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { X, ChevronRight, ChevronLeft } from "lucide-react";
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

const CAP_LABEL: Record<Capability, string> = {
  initiate: "INITIATE — who can trigger",
  see: "SEE — who can view",
  respond: "RESPOND — who can answer",
};
// Membership default per capability (no grant → this applies).
const capDefault = (cap: Capability) => (cap === "respond" ? "deny" : "allow");

type Perm = { cap: Capability; ec: string };

/**
 * Permission-FIRST authorization (docs/arch/ACP_EVENT_TAXONOMY.md): pick a
 * permission (capability × ACP event), then see/edit every authorization domain
 * that holds it — a user, a channel role, or a dynamic group — adding or
 * force-removing grants. The inverse of the scope-first matrix; same rules table.
 */
export function BotPermissionGrantsSection({ botId }: { botId: string }) {
  const [access, setAccess] = useState<EventAccess | null>(null);
  const [sel, setSel] = useState<Perm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [membersByChannel, setMembersByChannel] = useState<Record<string, MemberItem[]>>({});

  // add-grant draft
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
  const scopeLabel = (cid: string) => (cid ? channelLabel(cid) : "Bot-wide (all channels)");
  const subjectLabel = (r: EventRule): string => {
    if (r.subject_kind === "role") return r.subject_id === "*" ? "∗ any role" : `${r.subject_id} (role)`;
    if (r.subject_kind === "group")
      return access?.groups.find((g) => g.ref === r.subject_id)?.label || r.subject_id;
    return nameMap[r.subject_id] || `${r.subject_id.slice(0, 8)}…`;
  };

  const perms: Perm[] = useMemo(() => {
    if (!access) return [];
    const list: Perm[] = [];
    for (const ec of access.initiate_events) list.push({ cap: "initiate", ec });
    for (const ec of access.see_events) list.push({ cap: "see", ec });
    for (const ec of access.respond_events) list.push({ cap: "respond", ec });
    return list;
  }, [access]);

  const grantsFor = (p: Perm): EventRule[] =>
    (access?.rules ?? []).filter((r) => r.event_class === p.ec && r.capability === p.cap);

  // ── add-grant subject options for the chosen scope ──
  const scopeOptions = useMemo(() => {
    const opts = [{ val: "", label: "Bot-wide (all channels)" }];
    if (access) {
      for (const g of access.groups.filter((x) => x.ref.startsWith("channel:"))) {
        opts.push({ val: g.ref.slice("channel:".length), label: g.label.replace(/ members$/, "") });
      }
    }
    return opts;
  }, [access]);

  const usersForScope = (cid: string): MemberItem[] => {
    if (cid) return membersByChannel[cid] ?? [];
    // bot-wide: union of all known members
    const seen = new Set<string>();
    const out: MemberItem[] = [];
    for (const list of Object.values(membersByChannel)) {
      for (const u of list) if (!seen.has(u.member_id)) (seen.add(u.member_id), out.push(u));
    }
    return out;
  };

  if (!access) {
    return <p className="text-xs text-zinc-600 px-1 py-2">Loading permissions…</p>;
  }

  // ── Level 2: a selected permission's grants ──
  if (sel) {
    const grants = grantsFor(sel);
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 space-y-3">
        <button
          type="button"
          onClick={() => {
            setSel(null);
            setSubject("");
          }}
          className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> all permissions
        </button>
        <div>
          <p className="text-sm font-medium text-zinc-200">
            <code className="text-indigo-300">{sel.cap}</code> ·{" "}
            <code className="text-zinc-200">{sel.ec}</code>
          </p>
          <p className="text-[11px] text-zinc-600 mt-0.5">
            Domains granted this permission. With no matching grant, the default is{" "}
            <span className={capDefault(sel.cap) === "allow" ? "text-emerald-300" : "text-red-300"}>
              {capDefault(sel.cap)}
            </span>{" "}
            for channel members. Precedence: user ▸ group ▸ role ▸ ∗; deny wins ties.
          </p>
        </div>

        {/* grants list */}
        <div className="space-y-1.5">
          {grants.length === 0 && (
            <p className="text-[11px] text-zinc-600">No explicit grants — the default applies.</p>
          )}
          {grants.map((r) => (
            <div
              key={`${r.channel_id}:${r.subject_kind}:${r.subject_id}`}
              className="flex items-center gap-2 text-[11px] rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1.5"
            >
              <span
                className={`rounded px-1 py-0.5 text-[10px] border ${
                  r.subject_kind === "group"
                    ? "bg-violet-950/50 border-violet-900 text-violet-200"
                    : r.subject_kind === "user"
                    ? "bg-indigo-950/60 border-indigo-900 text-indigo-200"
                    : "bg-zinc-800 border-zinc-700 text-zinc-300"
                }`}
              >
                {r.subject_kind}
              </span>
              <span className="text-zinc-200">{subjectLabel(r)}</span>
              <span className="text-zinc-600">in</span>
              <span className="text-zinc-400">{scopeLabel(r.channel_id)}</span>
              <span
                className={`ml-auto ${r.decision === "allow" ? "text-emerald-300" : "text-red-300"}`}
              >
                {r.decision}
              </span>
              <button
                type="button"
                title="Force-remove this grant"
                disabled={busy !== null}
                onClick={() =>
                  run(`rm:${r.channel_id}:${r.subject_kind}:${r.subject_id}`, () =>
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

        {/* add grant */}
        <div className="border-t border-zinc-800 pt-2">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Add a grant</div>
          <div className="flex flex-wrap items-center gap-1.5">
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
              disabled={!subject || busy !== null}
              onClick={() =>
                run("add", async () => {
                  const [kind, ...rest] = subject.split(":");
                  await upsertEventRule(botId, {
                    channel_id: scope || undefined,
                    subject_kind: kind as SubjectKind,
                    subject_id: rest.join(":"),
                    event_class: sel.ec,
                    capability: sel.cap,
                    decision,
                  });
                  setSubject("");
                })
              }
              className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              + grant
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Level 1: the permission list ──
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 space-y-3">
      <div>
        <p className="text-xs font-medium text-zinc-300">Permissions</p>
        <p className="text-[11px] text-zinc-600 mt-0.5">
          Pick a permission to see and edit who holds it (users, roles, groups).
        </p>
      </div>
      {(["initiate", "see", "respond"] as Capability[]).map((cap) => (
        <div key={cap}>
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
            {CAP_LABEL[cap]}
          </div>
          <div className="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800 overflow-hidden">
            {perms
              .filter((p) => p.cap === cap)
              .map((p) => {
                const n = grantsFor(p).length;
                return (
                  <button
                    key={`${p.cap}:${p.ec}`}
                    type="button"
                    onClick={() => {
                      setSel(p);
                      setScope("");
                      setSubject("");
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-zinc-900/60"
                  >
                    <code className="text-xs text-zinc-200">{p.ec}</code>
                    {n > 0 ? (
                      <span className="text-[10px] rounded-full bg-indigo-950/60 border border-indigo-900 text-indigo-200 px-1.5">
                        {n} grant{n === 1 ? "" : "s"}
                      </span>
                    ) : (
                      <span className="text-[10px] text-zinc-600">
                        default {capDefault(cap)}
                      </span>
                    )}
                    <ChevronRight className="w-3.5 h-3.5 text-zinc-600 ml-auto" />
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}
