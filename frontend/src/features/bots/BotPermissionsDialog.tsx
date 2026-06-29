import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { ShieldCheck, X, RotateCcw } from "lucide-react";
import {
  getBotPermissions,
  setBotPosture,
  upsertBotRule,
  deleteBotRule,
  listBotApprovers,
  grantBotApprover,
  revokeBotApprover,
  type Decision,
  type PermissionRule,
  type BotApprover,
  type Posture,
} from "@/api/bots";
import { listChannelMembers } from "@/api/channels";
import { Dialog } from "@/components/ui/dialog";
import { Avatar } from "@/components/ui/avatar";
import type { BotItem, Channel, MemberItem } from "@/types";

const ANY_KIND = "*";
const BOT_WIDE = "";

const DECISIONS: { value: Decision; label: string }[] = [
  { value: "allow", label: "allow" },
  { value: "ask", label: "ask" },
  { value: "deny", label: "deny" },
];

const decisionCls: Record<Decision, string> = {
  allow: "text-emerald-300 border-emerald-800",
  ask: "text-amber-300 border-amber-800",
  deny: "text-red-300 border-red-800",
};

/**
 * Per-operation permission matrix (docs/arch/BOT_PERMISSION_MODEL.md, Axis B).
 * Rows = ACP operation kinds; each has a decision (allow/deny/ask) and, when
 * `ask`, the approvers who may resolve it. Decisions can be bot-wide or scoped
 * to a channel; approvers are always per-channel (so the "who" needs a channel).
 */
export function BotPermissionsDialog({
  bot,
  channels,
  onClose,
}: {
  bot: BotItem;
  channels: Channel[];
  onClose: () => void;
}) {
  const [scope, setScope] = useState<string>(BOT_WIDE); // "" = bot-wide default
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [posture, setPosture] = useState<Posture | null>(null);
  const [approvers, setApprovers] = useState<BotApprover[]>([]);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    const p = await getBotPermissions(bot.bot_id);
    setRules(p.rules);
    setKinds(p.standard_kinds);
    setPosture(p.posture);
  }, [bot.bot_id]);

  const changePosture = (mode: string) =>
    run("posture", () => setBotPosture(bot.bot_id, mode), loadRules);

  const loadChannelScoped = useCallback(async () => {
    if (!scope) {
      setApprovers([]);
      setMembers([]);
      setOwnerId(null);
      return;
    }
    const [a, m] = await Promise.all([
      listBotApprovers(bot.bot_id, scope),
      listChannelMembers(scope),
    ]);
    setApprovers(a.delegates);
    setOwnerId(a.owner_id);
    setMembers(m.filter((x) => x.member_type === "user"));
  }, [bot.bot_id, scope]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([loadRules(), loadChannelScoped()])
      .catch((e) => toast.error(String(e)))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [loadRules, loadChannelScoped]);

  const rows = useMemo(() => [...kinds, ANY_KIND], [kinds]);

  const ruleAt = useCallback(
    (channelId: string, kind: string): PermissionRule | undefined =>
      rules.find((r) => r.channel_id === channelId && r.operation_kind === kind),
    [rules]
  );

  // Resolved decision for the active scope: own rule → bot-wide rule → ask.
  function effective(kind: string): { decision: Decision; inherited: boolean; own: boolean } {
    const own = ruleAt(scope, kind);
    if (own) return { decision: own.decision, inherited: false, own: true };
    if (scope) {
      const bw = ruleAt(BOT_WIDE, kind);
      if (bw) return { decision: bw.decision, inherited: true, own: false };
    }
    return { decision: "ask", inherited: false, own: false };
  }

  async function run(key: string, fn: () => Promise<void>, reload: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
      await reload();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }

  const setDecision = (kind: string, decision: Decision) =>
    run(
      `d:${kind}`,
      () => upsertBotRule(bot.bot_id, { channel_id: scope || undefined, operation_kind: kind, decision }),
      loadRules
    );

  const clearRule = (kind: string) =>
    run(
      `d:${kind}`,
      () => deleteBotRule(bot.bot_id, { channel_id: scope || undefined, operation_kind: kind }),
      loadRules
    );

  const addApprover = (kind: string, userId: string) =>
    run(
      `a:${kind}`,
      () => grantBotApprover(bot.bot_id, { channel_id: scope, user_id: userId, operation_kind: kind }),
      loadChannelScoped
    );

  const removeApprover = (kind: string, userId: string) =>
    run(
      `a:${kind}`,
      () => revokeBotApprover(bot.bot_id, userId, { channel_id: scope, operation_kind: kind }),
      loadChannelScoped
    );

  function memberName(uid: string): string {
    const m = members.find((x) => x.member_id === uid);
    return m?.display_name || m?.username || `${uid.slice(0, 8)}…`;
  }

  const label = (k: string) => (k === ANY_KIND ? "∗ any other" : k);

  return (
    <Dialog
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-indigo-400" />
          Permissions · {bot.display_name || bot.username}
        </span>
      }
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        {/* Scope selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">Scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-500/60"
          >
            <option value={BOT_WIDE}>Bot-wide default (all channels)</option>
            {channels.map((c) => (
              <option key={c.channel_id} value={c.channel_id}>
                #{c.name}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-zinc-600">
            {scope
              ? "Channel-specific rules override the bot-wide default."
              : "Applies to every channel unless a channel overrides it."}
          </span>
        </div>

        {/* Posture (Axis A): the agent's session mode (when does it ask?). */}
        {posture && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-zinc-300">Agent posture</span>
              {posture.allowed_modes.length > 0 ? (
                <select
                  value={posture.permission_mode ?? ""}
                  disabled={busy === "posture"}
                  onChange={(e) => changePosture(e.target.value)}
                  className="rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500/60 disabled:opacity-40"
                >
                  {posture.permission_mode == null && <option value="">(unset)</option>}
                  {posture.allowed_modes.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[11px] text-zinc-600">
                  {posture.agent_type} advertises its own modes — no preset envelope
                </span>
              )}
              <span className="ml-auto text-[11px] text-zinc-600">
                agent: <code className="text-zinc-500">{posture.agent_type}</code>
              </span>
            </div>
            <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
              The session mode controls <em>when the agent asks</em> (e.g.{" "}
              <code className="text-zinc-500">default</code> = prompt per tool,{" "}
              <code className="text-zinc-500">plan</code> = no execution). Pushed to the live
              connector via <code className="text-zinc-500">set_mode</code>, clamped by the host’s
              L0 allow-list.
            </p>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-zinc-500 px-1 py-6 text-center">Loading…</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-900/70 text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className="text-left font-medium px-3 py-2">Operation</th>
                  <th className="text-left font-medium px-3 py-2 w-40">Decision</th>
                  <th className="text-left font-medium px-3 py-2">Approvers (when “ask”)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {rows.map((kind) => {
                  const eff = effective(kind);
                  const k = busy === `d:${kind}` || busy === `a:${kind}`;
                  const kindApprovers = approvers.filter((a) => a.operation_kind === kind);
                  const candidates = members.filter(
                    (m) =>
                      m.member_id !== ownerId &&
                      !kindApprovers.some((a) => a.user_id === m.member_id)
                  );
                  return (
                    <tr key={kind} className="bg-zinc-950/40">
                      <td className="px-3 py-2 align-top">
                        <code className="text-zinc-300">{label(kind)}</code>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="flex items-center gap-1.5">
                          <select
                            value={eff.decision}
                            disabled={k}
                            onChange={(e) => setDecision(kind, e.target.value as Decision)}
                            className={`rounded-md bg-zinc-800 border px-2 py-1 text-xs outline-none disabled:opacity-40 ${decisionCls[eff.decision]}`}
                          >
                            {DECISIONS.map((d) => (
                              <option key={d.value} value={d.value} className="text-zinc-200">
                                {d.label}
                              </option>
                            ))}
                          </select>
                          {eff.inherited && (
                            <span className="text-[10px] text-zinc-600" title="inherited from bot-wide default">
                              inherited
                            </span>
                          )}
                          {eff.own && (
                            <button
                              type="button"
                              title={scope ? "Reset to bot-wide default" : "Clear rule"}
                              onClick={() => clearRule(kind)}
                              disabled={k}
                              className="text-zinc-600 hover:text-zinc-300 disabled:opacity-40"
                            >
                              <RotateCcw className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {eff.decision !== "ask" ? (
                          <span className="text-xs text-zinc-600">—</span>
                        ) : !scope ? (
                          <span className="text-[11px] text-zinc-600">
                            pick a channel to set approvers
                          </span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                              owner
                            </span>
                            {kindApprovers.map((a) => (
                              <span
                                key={a.user_id}
                                className="inline-flex items-center gap-1 rounded-full bg-indigo-950/60 border border-indigo-900 px-2 py-0.5 text-[11px] text-indigo-200"
                              >
                                <Avatar name={memberName(a.user_id)} id={a.user_id} size="xs" />
                                {memberName(a.user_id)}
                                <button
                                  type="button"
                                  onClick={() => removeApprover(kind, a.user_id)}
                                  disabled={k}
                                  className="text-indigo-300 hover:text-red-300 disabled:opacity-40"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            ))}
                            {candidates.length > 0 && (
                              <select
                                value=""
                                disabled={k}
                                onChange={(e) => e.target.value && addApprover(kind, e.target.value)}
                                className="rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 outline-none disabled:opacity-40"
                              >
                                <option value="">+ add…</option>
                                {candidates.map((m) => (
                                  <option key={m.member_id} value={m.member_id}>
                                    {m.display_name || m.username}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-zinc-600 leading-relaxed">
          A rule decides whether the agent’s ACP operation is auto-allowed, denied, or sent to a
          human as an approval card. The <code className="text-zinc-500">∗ any other</code> row is
          the fallback for kinds without their own rule. The <code className="text-zinc-500">owner</code>{" "}
          can always approve; add channel members to let them approve a specific kind too.
        </p>
      </div>
    </Dialog>
  );
}
