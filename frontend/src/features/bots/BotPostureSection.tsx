import { useCallback, useEffect, useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import {
  getBotPermissions,
  setBotPosture,
  setBotConfigOption,
  type BotPermissions,
} from "@/api/bots";

// Display helper: show UUID-like ids in a short 8-char form (full id in the tooltip);
// human-readable config ids (e.g. "model") are shown as-is.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Posture surface (docs/arch/ACP_EVENT_TAXONOMY.md): the agent's session mode (when does
 * it ask?) + the session config options it advertised (model / reasoning / …). Self-loading
 * so it can live inline in the bot detail pane. Extracted from the old BotPermissionsDialog.
 */
export function BotPostureSection({ botId }: { botId: string }) {
  const [perms, setPerms] = useState<BotPermissions | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualConfigId, setManualConfigId] = useState("");
  const [manualConfigValue, setManualConfigValue] = useState("");

  const load = useCallback(async () => {
    setPerms(await getBotPermissions(botId));
  }, [botId]);

  useEffect(() => {
    load().catch((e) => notify.error(messageOf(e)));
  }, [load]);

  const changePosture = (mode: string) => {
    setBusy(true);
    setBotPosture(botId, mode)
      .then(load)
      .catch((e) => notify.error(messageOf(e)))
      .finally(() => setBusy(false));
  };

  const changeConfigOption = (configId: string, value: string) => {
    setBusy(true);
    setBotConfigOption(botId, configId, value)
      .then(load)
      .catch((e) => notify.error(messageOf(e)))
      .finally(() => setBusy(false));
  };

  const submitManualConfig = () => {
    const configId = manualConfigId.trim();
    const value = manualConfigValue.trim();
    if (!configId || !value) return;
    setBusy(true);
    setBotConfigOption(botId, configId, value)
      .then(() => {
        setManualConfigId("");
        setManualConfigValue("");
        return load();
      })
      .catch((e) => notify.error(messageOf(e)))
      .finally(() => setBusy(false));
  };

  if (!perms) return <p className="text-xs text-zinc-400 px-1 py-2">Loading…</p>;

  const posture = perms.posture;
  const configOptions = perms.config_options;

  return (
    <div className="space-y-3">
      {posture && (
        <div className="rounded-xl bg-zinc-950/40 p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-zinc-300">Agent posture</span>
            {posture.allowed_modes.length > 0 ? (
              <select
                value={posture.permission_mode ?? ""}
                disabled={busy}
                onChange={(e) => changePosture(e.target.value)}
                className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              >
                {posture.permission_mode == null && <option value="">(unset)</option>}
                {posture.allowed_modes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[11px] text-zinc-400">
                {posture.agent_type} advertises its own modes — no preset envelope
              </span>
            )}
            <span className="ml-auto text-[11px] text-zinc-400">
              agent: <code className="text-zinc-400">{posture.agent_type}</code>
            </span>
          </div>
          <p className="text-[11px] text-zinc-400 mt-2 leading-relaxed">
            The session mode controls <em>when the agent asks</em> (e.g.{" "}
            <code className="text-zinc-400">default</code> = prompt per tool,{" "}
            <code className="text-zinc-400">plan</code> = no execution). Switching it is the
            “Switch approval mode” permission in the grants below — pushed to the live
            connector, clamped by the host’s L0 allow-list.
          </p>
          <p className="text-[11px] text-zinc-400 mt-2 leading-relaxed">
            Approval cards only appear when the agent chooses to ask. To require human
            review of commits, keep <code className="text-zinc-400">git commit</code> /{" "}
            <code className="text-zinc-400">git push</code> out of the agent’s auto-allow
            rules — a whitelisted <code className="text-zinc-400">Bash(git *)</code> bypasses
            the card entirely (the platform doesn’t intercept already-allowed commands).
          </p>
        </div>
      )}

      {/* Session config options (model / reasoning level / …) the agent advertised. */}
      <div className="rounded-xl bg-zinc-950/40 p-3">
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
                    className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
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
                    <code className="ml-auto text-[10px] text-zinc-400">{opt.category}</code>
                  )}
                </div>
              );
            })}
            <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">
              Changing these is the “Change agent settings” permission in the grants below —
              owner-set overrides are pushed to the connector and applied to every session,
              clamped by the host’s L0 allow-list.
            </p>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {configOptions && Object.keys(configOptions.desired).length > 0 && (
              <div className="space-y-1">
                {Object.entries(configOptions.desired).map(([id, value]) => (
                  <div key={id} className="flex items-center gap-2 text-[11px]">
                    <code
                      className="text-zinc-400 min-w-[120px]"
                      title={UUID_RE.test(id) ? id : undefined}
                    >
                      {UUID_RE.test(id) ? `${id.slice(0, 8)}…` : id}
                    </code>
                    <span className="text-zinc-400 truncate">{value}</span>
                    <span className="ml-auto text-[10px] text-indigo-400">override</span>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
              <input
                value={manualConfigId}
                disabled={busy}
                onChange={(e) => setManualConfigId(e.target.value)}
                placeholder="config id"
                className="min-w-0 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              />
              <input
                value={manualConfigValue}
                disabled={busy}
                onChange={(e) => setManualConfigValue(e.target.value)}
                placeholder="value"
                className="min-w-0 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              />
              <button
                type="button"
                disabled={busy || !manualConfigId.trim() || !manualConfigValue.trim()}
                onClick={submitManualConfig}
                title="Apply this config override"
                className="rounded-md bg-indigo-500/15 px-3 py-1 text-xs text-indigo-200 hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Set
              </button>
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              This agent has not advertised selectable options. Manual overrides are still
              checked by the connector’s L0 allow-list.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
