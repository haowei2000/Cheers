import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { X } from "lucide-react";
import {
  getEventAccess,
  upsertEventRule,
  deleteEventRule,
  type EventAccess,
  type Capability,
  type SubjectKind,
} from "@/api/bots";
import type { MemberItem } from "@/types";

const ROLES = ["*", "owner", "admin", "member"] as const;
type Cell = "default" | "allow" | "deny";

const CAP_BLOCKS: { cap: Capability; label: string; hint: string; events: (a: EventAccess) => string[] }[] = [
  { cap: "initiate", label: "INITIATE — who can trigger", hint: "default (allow)", events: (a) => a.initiate_events },
  { cap: "see", label: "SEE — who can view", hint: "default (allow)", events: (a) => a.see_events },
  { cap: "respond", label: "RESPOND — who can answer", hint: "default (deny)", events: (a) => a.respond_events },
];

/**
 * Event-access matrix (docs/arch/ACP_EVENT_TAXONOMY.md, Axis: per-user authz):
 * for the active scope, per ACP event-class × channel role (with per-user
 * overrides) — may this subject INITIATE / SEE / RESPOND? Layers on membership.
 */
export function BotEventAccessSection({
  botId,
  scope,
  members,
}: {
  botId: string;
  scope: string; // "" = bot-wide default
  members: MemberItem[];
}) {
  const [access, setAccess] = useState<EventAccess | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // add-override draft
  const [ovUser, setOvUser] = useState("");
  const [ovEvent, setOvEvent] = useState("");
  const [ovCap, setOvCap] = useState<Capability>("initiate");
  const [ovDecision, setOvDecision] = useState<"allow" | "deny">("allow");

  const load = useCallback(async () => {
    try {
      setAccess(await getEventAccess(botId));
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

  const cellValue = (role: string, ec: string, cap: Capability): Cell => {
    const r = access?.rules.find(
      (x) =>
        x.channel_id === scope &&
        x.subject_kind === "role" &&
        x.subject_id === role &&
        x.event_class === ec &&
        x.capability === cap
    );
    return r ? r.decision : "default";
  };

  const setCell = (role: string, ec: string, cap: Capability, val: Cell) =>
    run(`${cap}:${ec}:${role}`, () =>
      val === "default"
        ? deleteEventRule(botId, {
            channel_id: scope || undefined,
            subject_kind: "role",
            subject_id: role,
            event_class: ec,
            capability: cap,
          })
        : upsertEventRule(botId, {
            channel_id: scope || undefined,
            subject_kind: "role",
            subject_id: role,
            event_class: ec,
            capability: cap,
            decision: val,
          })
    );

  const userRules = (access?.rules ?? []).filter(
    (r) => r.channel_id === scope && r.subject_kind === "user"
  );
  const memberName = (uid: string) => {
    const m = members.find((x) => x.member_id === uid);
    return m?.display_name || m?.username || `${uid.slice(0, 8)}…`;
  };

  const allEvents = access
    ? Array.from(
        new Set([...access.initiate_events, ...access.see_events, ...access.respond_events])
      )
    : [];
  const capEvents = (cap: Capability): string[] =>
    !access
      ? []
      : cap === "initiate"
      ? access.initiate_events
      : cap === "see"
      ? access.see_events
      : access.respond_events;

  const cellCls: Record<Cell, string> = {
    default: "text-zinc-500 border-zinc-700",
    allow: "text-emerald-300 border-emerald-800",
    deny: "text-red-300 border-red-800",
  };

  if (!access) {
    return <p className="text-xs text-zinc-600 px-1 py-2">Loading event access…</p>;
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 space-y-4">
      <div>
        <p className="text-xs font-medium text-zinc-300">Event access</p>
        <p className="text-[11px] text-zinc-600 mt-0.5">
          Per ACP event, which channel roles may act. Layers on membership — a row only
          narrows (deny) or widens (respond) within the channel. Per-user overrides win.
        </p>
      </div>

      {CAP_BLOCKS.map((blk) => (
        <div key={blk.cap}>
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{blk.label}</div>
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-zinc-900/70 text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="text-left font-medium px-2 py-1.5">event</th>
                  {ROLES.map((role) => (
                    <th key={role} className="text-left font-medium px-2 py-1.5">
                      {role === "*" ? "∗ any" : role}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {blk.events(access).map((ec) => (
                  <tr key={ec} className="bg-zinc-950/30">
                    <td className="px-2 py-1.5">
                      <code className="text-zinc-300">{ec}</code>
                    </td>
                    {ROLES.map((role) => {
                      const v = cellValue(role, ec, blk.cap);
                      const k = busy === `${blk.cap}:${ec}:${role}`;
                      return (
                        <td key={role} className="px-2 py-1.5">
                          <select
                            value={v}
                            disabled={k}
                            onChange={(e) => setCell(role, ec, blk.cap, e.target.value as Cell)}
                            className={`rounded-md bg-zinc-800 border px-1.5 py-0.5 text-[11px] outline-none disabled:opacity-40 ${cellCls[v]}`}
                          >
                            <option value="default" className="text-zinc-300">
                              {blk.hint}
                            </option>
                            <option value="allow" className="text-zinc-300">allow</option>
                            <option value="deny" className="text-zinc-300">deny</option>
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Per-user overrides */}
      <div>
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
          Per-user overrides
        </div>
        {!scope ? (
          <p className="text-[11px] text-zinc-600">Pick a channel to add per-user overrides.</p>
        ) : (
          <div className="space-y-1.5">
            {userRules.length === 0 && (
              <p className="text-[11px] text-zinc-600">No per-user overrides in this channel.</p>
            )}
            {userRules.map((r) => (
              <div
                key={`${r.subject_id}:${r.event_class}:${r.capability}`}
                className="flex items-center gap-2 text-[11px] text-zinc-300"
              >
                <span className="text-zinc-200">{memberName(r.subject_id)}</span>
                <code className="text-zinc-500">{r.capability}</code>
                <code className="text-zinc-500">{r.event_class}</code>
                <span className={r.decision === "allow" ? "text-emerald-300" : "text-red-300"}>
                  {r.decision}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    run(`rm:${r.subject_id}:${r.event_class}:${r.capability}`, () =>
                      deleteEventRule(botId, {
                        channel_id: scope || undefined,
                        subject_kind: "user" as SubjectKind,
                        subject_id: r.subject_id,
                        event_class: r.event_class,
                        capability: r.capability,
                      })
                    )
                  }
                  className="text-zinc-600 hover:text-red-300"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {/* add override */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <select
                value={ovUser}
                onChange={(e) => setOvUser(e.target.value)}
                className="rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300"
              >
                <option value="">user…</option>
                {members.map((m) => (
                  <option key={m.member_id} value={m.member_id}>
                    {m.display_name || m.username}
                  </option>
                ))}
              </select>
              <select
                value={ovCap}
                onChange={(e) => {
                  setOvCap(e.target.value as Capability);
                  setOvEvent("");
                }}
                className="rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300"
              >
                <option value="initiate">initiate</option>
                <option value="see">see</option>
                <option value="respond">respond</option>
              </select>
              <select
                value={ovEvent}
                onChange={(e) => setOvEvent(e.target.value)}
                className="rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300"
              >
                <option value="">event…</option>
                {capEvents(ovCap).map((ec) => (
                  <option key={ec} value={ec}>
                    {ec}
                  </option>
                ))}
              </select>
              <select
                value={ovDecision}
                onChange={(e) => setOvDecision(e.target.value as "allow" | "deny")}
                className="rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300"
              >
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
              <button
                type="button"
                disabled={!ovUser || !ovEvent || busy === "addov"}
                onClick={() =>
                  run("addov", async () => {
                    await upsertEventRule(botId, {
                      channel_id: scope || undefined,
                      subject_kind: "user",
                      subject_id: ovUser,
                      event_class: ovEvent,
                      capability: ovCap,
                      decision: ovDecision,
                    });
                    setOvUser("");
                    setOvEvent("");
                  })
                }
                className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                + add
              </button>
            </div>
          </div>
        )}
      </div>
      {allEvents.length === 0 && (
        <p className="text-[11px] text-zinc-600">No event vocabulary returned.</p>
      )}
    </div>
  );
}
