import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ShieldCheck, SlidersHorizontal, KeyRound, Activity } from "lucide-react";
import {
  getBotPermissions,
  setBotPosture,
  setBotConfigOption,
  type BotPermissions,
} from "@/api/bots";
import { Dialog } from "@/components/ui/dialog";
import { BotPermissionGrantsSection } from "./BotPermissionGrantsSection";
import { BotActivitySection } from "./BotActivitySection";
import type { BotItem } from "@/types";

type Tab = "posture" | "grants" | "activity";

const TABS: { id: Tab; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: "posture", label: "Posture", icon: SlidersHorizontal },
  { id: "grants", label: "Grants", icon: KeyRound },
  { id: "activity", label: "Activity", icon: Activity },
];

/**
 * Bot permissions (docs/arch/ACP_EVENT_TAXONOMY.md), split into three tabs:
 *   • Posture  — the agent's session mode (when does it ask?)
 *   • Grants   — who is authorized for which ACP event (initiate / see / respond)
 *   • Activity — the live, read-only ACP event timeline
 * Each surface grew enough that stacking them made one tall scroll; tabs keep
 * each focused. Scope is chosen per-grant, not page-wide.
 */
export function BotPermissionsDialog({
  bot,
  onClose,
}: {
  bot: BotItem;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("posture");
  const [perms, setPerms] = useState<BotPermissions | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setPerms(await getBotPermissions(bot.bot_id));
  }, [bot.bot_id]);

  useEffect(() => {
    load().catch((e) => toast.error(String(e)));
  }, [load]);

  const changePosture = (mode: string) => {
    setBusy(true);
    setBotPosture(bot.bot_id, mode)
      .then(load)
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };

  const changeConfigOption = (configId: string, value: string) => {
    setBusy(true);
    setBotConfigOption(bot.bot_id, configId, value)
      .then(load)
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };

  const posture = perms?.posture ?? null;
  const configOptions = perms?.config_options;

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
      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-zinc-800 -mt-1 mb-4">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-indigo-500 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Posture: the agent's session mode (when does it ask?) + session config options. */}
      {tab === "posture" &&
        (!perms ? (
          <p className="text-xs text-zinc-600 px-1 py-2">Loading…</p>
        ) : (
          <div className="space-y-3">
            {posture && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-zinc-300">Agent posture</span>
                  {posture.allowed_modes.length > 0 ? (
                    <select
                      value={posture.permission_mode ?? ""}
                      disabled={busy}
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
                  connector via <code className="text-zinc-500">set_mode</code>, clamped by the
                  host’s L0 allow-list.
                </p>
              </div>
            )}

            {/* Session config options (model / reasoning level / …) the agent advertised. */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
              <p className="text-xs font-medium text-zinc-300">Session config options</p>
              {configOptions && configOptions.advertised.length > 0 ? (
                <div className="mt-2 space-y-2">
                  {configOptions.advertised.map((opt) => {
                    const current = configOptions.desired[opt.id] ?? opt.currentValue;
                    return (
                      <div key={opt.id} className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] text-zinc-400 min-w-[90px]">{opt.name}</span>
                        <select
                          value={current}
                          disabled={busy}
                          onChange={(e) => changeConfigOption(opt.id, e.target.value)}
                          className="rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500/60 disabled:opacity-40"
                        >
                          {opt.options.map((v) => (
                            <option key={v.value} value={v.value}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                        {configOptions.desired[opt.id] != null && (
                          <span className="text-[10px] text-indigo-400">override</span>
                        )}
                        {opt.category && (
                          <code className="ml-auto text-[10px] text-zinc-600">{opt.category}</code>
                        )}
                      </div>
                    );
                  })}
                  <p className="text-[11px] text-zinc-600 mt-1 leading-relaxed">
                    Owner-set overrides are pushed to the connector and applied to every session via{" "}
                    <code className="text-zinc-500">set_config_option</code>, clamped by the host’s L0
                    allow-list.
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-zinc-600 mt-1">
                  This agent hasn’t advertised any session config options (or hasn’t connected yet).
                </p>
              )}
            </div>
          </div>
        ))}

      {/* Grants: who may initiate / see / respond to which ACP event. */}
      {tab === "grants" && <BotPermissionGrantsSection botId={bot.bot_id} />}

      {/* Activity: the complete ACP event timeline (read-only). */}
      {tab === "activity" && <BotActivitySection botId={bot.bot_id} />}
    </Dialog>
  );
}
