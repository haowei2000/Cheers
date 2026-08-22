import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
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
    <section className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <p className="text-section-label">Agent settings</p>
          <p className="mt-1 text-compact text-content-muted">Settings apply to new sessions and remain within the host’s allow-list.</p>
        </div>
        {posture && <span className="text-compact text-content-muted">Agent: {posture.agent_type}</span>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {posture && (
          <Field label="Mode">
            {posture.allowed_modes.length > 0 ? (
              <UiSelect value={posture.permission_mode ?? ""} disabled={busy} onChange={(e) => changePosture(e.target.value)} controlSize="regular">
                {posture.permission_mode == null && <option value="">(unset)</option>}
                {posture.allowed_modes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </UiSelect>
            ) : <p className="pt-2 text-compact text-content-muted">This agent controls its own mode.</p>}
          </Field>
        )}

        {configOptions?.advertised.map((opt) => {
          const current = configOptions.desired[opt.id] ?? opt.currentValue;
          return (
            <Field key={opt.id} label={<span className="flex items-center gap-2">
                {opt.name}
                {configOptions.desired[opt.id] != null && <span className="text-minimal normal-case tracking-normal text-accent-400">Override</span>}
              </span>}>
              <UiSelect value={current} disabled={busy} onChange={(e) => changeConfigOption(opt.id, e.target.value)} controlSize="regular">
                {opt.options.map((value) => <option key={value.value} value={value.value}>{value.name}</option>)}
              </UiSelect>
            </Field>
          );
        })}
      </div>

      {(!configOptions || configOptions.advertised.length === 0) && (
        <details className="rounded-sm bg-zinc-900 px-3 py-2">
          <summary className="cursor-pointer text-compact text-content-secondary">Advanced configuration override</summary>
          <div className="mt-3 space-y-3">
            {configOptions && Object.keys(configOptions.desired).length > 0 && (
              <div className="space-y-1 text-compact text-content-muted">
                {Object.entries(configOptions.desired).map(([id, value]) => (
                  <p key={id}><code title={UUID_RE.test(id) ? id : undefined}>{UUID_RE.test(id) ? `${id.slice(0, 8)}…` : id}</code>: {value}</p>
                ))}
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <UiInput value={manualConfigId} disabled={busy} onChange={(e) => setManualConfigId(e.target.value)} placeholder="Config ID" controlSize="regular" />
              <UiInput value={manualConfigValue} disabled={busy} onChange={(e) => setManualConfigValue(e.target.value)} placeholder="Value" controlSize="regular" />
              <UiButton action="update" variant="secondary" type="button" disabled={busy || !manualConfigId.trim() || !manualConfigValue.trim()} onClick={submitManualConfig} controlSize="regular">Set</UiButton>
            </div>
          </div>
        </details>
      )}

      <details className="rounded-sm bg-zinc-900 px-3 py-2">
        <summary className="cursor-pointer text-compact text-content-secondary">How agent settings work</summary>
        <div className="mt-3 space-y-2 text-compact leading-reading text-content-muted">
          <p>Mode controls when the agent asks for approval. Changing it requires the matching permission grant and is pushed to the live connector.</p>
          <p>To require review of commits, do not auto-allow <code>git commit</code> or <code>git push</code> in the agent’s own rules.</p>
        </div>
      </details>
    </section>
  );
}
