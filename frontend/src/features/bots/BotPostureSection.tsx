import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
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

  if (!perms) return <p className="text-compact text-content-muted px-1 py-2">Loading…</p>;

  const posture = perms.posture;
  const configOptions = perms.config_options;

  return (
    <div className="space-y-3">
      {posture && (
        <div className="rounded-sm bg-zinc-950/40 p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-compact font-medium text-content-secondary">Agent posture</span>
            {posture.allowed_modes.length > 0 ? (
              <UiSelect
                value={posture.permission_mode ?? ""}
                disabled={busy}
                onChange={(e) => changePosture(e.target.value)}
                controlSize="regular" className="rounded-sm bg-zinc-800 text-compact text-content-secondary focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              >
                {posture.permission_mode == null && <option value="">(unset)</option>}
                {posture.allowed_modes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </UiSelect>
            ) : (
              <span className="text-compact text-content-muted">
                {posture.agent_type} advertises its own modes — no preset envelope
              </span>
            )}
            <span className="ml-auto text-compact text-content-muted">
              agent: <code className="text-content-muted">{posture.agent_type}</code>
            </span>
          </div>
          <p className="text-compact text-content-muted mt-2 leading-reading">
            The session mode controls <em>when the agent asks</em> (e.g.{" "}
            <code className="text-content-muted">default</code> = prompt per tool,{" "}
            <code className="text-content-muted">plan</code> = no execution). Switching it is the
            “Switch approval mode” permission in the grants below — pushed to the live
            connector, clamped by the host’s L0 allow-list.
          </p>
          <p className="text-compact text-content-muted mt-2 leading-reading">
            Approval cards only appear when the agent chooses to ask. To require human
            review of commits, keep <code className="text-content-muted">git commit</code> /{" "}
            <code className="text-content-muted">git push</code> out of the agent’s auto-allow
            rules — a whitelisted <code className="text-content-muted">Bash(git *)</code> bypasses
            the card entirely (the platform doesn’t intercept already-allowed commands).
          </p>
        </div>
      )}

      {/* Session config options (model / reasoning level / …) the agent advertised. */}
      <div className="rounded-sm bg-zinc-950/40 p-3">
        <p className="text-compact font-medium text-content-secondary">Session config options</p>
        {configOptions && configOptions.advertised.length > 0 ? (
          <div className="mt-2 space-y-2">
            {configOptions.advertised.map((opt) => {
              const current = configOptions.desired[opt.id] ?? opt.currentValue;
              return (
                <div key={opt.id} className="flex items-center gap-2 flex-wrap">
                  <span className="text-compact text-content-muted min-w-[90px]">{opt.name}</span>
                  <UiSelect
                    value={current}
                    disabled={busy}
                    onChange={(e) => changeConfigOption(opt.id, e.target.value)}
                    controlSize="regular" className="rounded-sm bg-zinc-800 text-compact text-content-secondary focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                  >
                    {opt.options.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.name}
                      </option>
                    ))}
                  </UiSelect>
                  {configOptions.desired[opt.id] != null && (
                    <span className="text-minimal text-accent-400">override</span>
                  )}
                  {opt.category && (
                    <code className="ml-auto text-minimal text-content-muted">{opt.category}</code>
                  )}
                </div>
              );
            })}
            <p className="text-compact text-content-muted mt-1 leading-reading">
              Changing these is the “Change agent settings” permission in the grants below —
              owner-set overrides are pushed to the connector and applied to every session,
              clamped by the host’s L0 allow-list.
            </p>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {configOptions && Object.keys(configOptions.desired).length > 0 && (
              <div className="space-y-1">
                {/* design-system-exempt: form-field — configuration key/value editor. */}
                {Object.entries(configOptions.desired).map(([id, value]) => (
                  <div key={id} className="flex items-center gap-2 text-compact">
                    <code
                      className="text-content-muted min-w-[120px]"
                      title={UUID_RE.test(id) ? id : undefined}
                    >
                      {UUID_RE.test(id) ? `${id.slice(0, 8)}…` : id}
                    </code>
                    <span className="text-content-muted truncate">{value}</span>
                    <span className="ml-auto text-minimal text-accent-400">override</span>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
              <UiInput
                value={manualConfigId}
                disabled={busy}
                onChange={(e) => setManualConfigId(e.target.value)}
                placeholder="config id"
                controlSize="regular" className="min-w-0 rounded-sm bg-zinc-800 text-compact text-content-secondary focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              />
              <UiInput
                value={manualConfigValue}
                disabled={busy}
                onChange={(e) => setManualConfigValue(e.target.value)}
                placeholder="value"
                controlSize="regular" className="min-w-0 rounded-sm bg-zinc-800 text-compact text-content-secondary focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              />
              <UiButton action="update" variant="plain"
                type="button"
                disabled={busy || !manualConfigId.trim() || !manualConfigValue.trim()}
                onClick={submitManualConfig}
                title="Apply this config override"
                controlSize="regular" className="rounded-sm bg-indigo-500/15  text-accent-200 hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Set
              </UiButton>
            </div>
            <p className="text-compact text-content-muted leading-reading">
              This agent has not advertised selectable options. Manual overrides are still
              checked by the connector’s L0 allow-list.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
