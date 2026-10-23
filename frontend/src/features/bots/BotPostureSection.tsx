import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
import { Field, SectionHead } from "@/components/ui/field";
import { useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import {
  setBotPosture,
  setBotConfigOption,
} from "@/api/bots";
import { useBotPermissions } from "./botPermissionsCache";
import { AgentOptionsFeedback } from "./AgentOptionsFeedback";
import { bustAllBotControls } from "@/features/chat/sessionControlsCache";

// Display helper: show UUID-like ids in a short 8-char form (full id in the tooltip);
// human-readable config ids (e.g. "model") are shown as-is.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Posture surface (docs/arch/ACP_EVENT_TAXONOMY.md): the agent's session mode (when does
 * it ask?) + the session config options it advertised (model / reasoning / …). Self-loading
 * so it can live inline in the bot detail pane. Extracted from the old BotPermissionsDialog.
 */
export function BotPostureSection({ botId }: { botId: string }) {
  const { data: perms, loading, error, refresh } = useBotPermissions(botId);
  const [busy, setBusy] = useState(false);
  const [manualConfigId, setManualConfigId] = useState("");
  const [manualConfigValue, setManualConfigValue] = useState("");

  const reload = () => {
    bustAllBotControls(botId);
    refresh();
  };

  const changePosture = (mode: string) => {
    setBusy(true);
    setBotPosture(botId, mode)
      .then(reload)
      .catch((e) => notify.error(messageOf(e)))
      .finally(() => setBusy(false));
  };

  const changeConfigOption = (configId: string, value: string) => {
    setBusy(true);
    setBotConfigOption(botId, configId, value)
      .then(reload)
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
        reload();
      })
      .catch((e) => notify.error(messageOf(e)))
      .finally(() => setBusy(false));
  };

  if (error || !perms) return <AgentOptionsFeedback loading={loading || !error} error={error} onRetry={refresh} />;

  const posture = perms.posture;
  const configOptions = perms.config_options;

  return (
    <section className="space-y-5" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <SectionHead
          className="mb-0"
          tip="Settings apply to new sessions and remain within the host’s allow-list. Mode controls when the agent asks for approval."
        >
          Agent settings
        </SectionHead>
        {posture && <span className="text-compact text-content-muted">Agent: {posture.agent_type}</span>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {posture && (
          <Field
            label="Mode"
            tip="Mode controls when the agent stops to ask you before acting."
          >
            {posture.allowed_modes.length > 0 ? (
              <UiSelect aria-label="Agent mode" value={posture.permission_mode ?? ""} disabled={busy || loading} onChange={(e) => changePosture(e.target.value)} controlSize="regular">
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
              <UiSelect aria-label={opt.name} value={current} disabled={busy || loading} onChange={(e) => changeConfigOption(opt.id, e.target.value)} controlSize="regular">
                {current && !opt.options.some((value) => value.value === current) && <option value={current}>{current}</option>}
                {opt.options.map((value) => <option key={value.value} value={value.value}>{value.name}</option>)}
              </UiSelect>
            </Field>
          );
        })}
      </div>

      {(!configOptions || configOptions.advertised.length === 0) && (
        <AgentOptionsFeedback loading={loading} onRetry={refresh} />
      )}

      {(!configOptions || configOptions.advertised.length === 0) && (
        <details className="rounded-sm bg-control/40 px-3 py-2">
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
              <UiInput aria-label="Config ID" value={manualConfigId} disabled={busy} onChange={(e) => setManualConfigId(e.target.value)} placeholder="Config ID" controlSize="regular" />
              <UiInput aria-label="Config value" value={manualConfigValue} disabled={busy} onChange={(e) => setManualConfigValue(e.target.value)} placeholder="Value" controlSize="regular" />
              <UiButton action="update" variant="secondary" type="button" disabled={busy || !manualConfigId.trim() || !manualConfigValue.trim()} onClick={submitManualConfig} controlSize="regular">Set</UiButton>
            </div>
          </div>
        </details>
      )}
    </section>
  );
}
