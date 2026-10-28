import { Select as UiSelect } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import { controlIconClasses } from "@/components/ui/control-size";
import { useEffect, useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import toast from "react-hot-toast";
import { SlidersHorizontal, Lock } from "lucide-react";
import {
  setSessionMode,
  setSessionConfigOption,
} from "@/api/sessionControl";
import { useBotControls, resolveTargetSession, bustBotControls } from "./sessionControlsCache";
import { AgentOptionsFeedback } from "@/features/bots/AgentOptionsFeedback";

export interface MentionedBot {
  botId: string;
  name: string;
}

/**
 * Inline mode/config controls for the bot(s) currently @mentioned in the composer —
 * or, when nothing is mentioned, the channel's bots (the parent passes the
 * fallback set, so the controls are reachable without typing a mention)
 * (docs/arch/SESSION_MODEL.md). The CURRENT mode + config values are always shown
 * for any channel member; whether they're editable is gated per-control by the
 * caller's set_mode / set_config_option INITIATE grant. No grant → the value is
 * rendered read-only (disabled, no dropdown affordance) so you can see it but not
 * change it.
 *
 * Values shown are the session's effective ones: a per-session override
 * (session_config) when present, otherwise the bot/agent default. Changes apply to
 * the session the message will route to (the selected one if it's this bot's, else
 * the bot's primary).
 */
export function ComposerBotSettings({
  channelId,
  bots,
  selectedSessionId,
}: {
  channelId: string;
  bots: MentionedBot[];
  selectedSessionId: string;
}) {
  return (
    <>
      {bots.map((b) => (
        <BotInlineSettings
          key={b.botId}
          channelId={channelId}
          bot={b}
          selectedSessionId={selectedSessionId}
        />
      ))}
    </>
  );
}

function BotInlineSettings({
  channelId,
  bot,
  selectedSessionId,
}: {
  channelId: string;
  bot: MentionedBot;
  selectedSessionId: string;
}) {
  const { data, loading, error, refresh } = useBotControls(channelId, bot.botId, selectedSessionId);
  const controls = data?.controls;
  const [busy, setBusy] = useState(false);
  // Optimistic overlay so an applied change shows immediately; cleared when the
  // baseline (target session / controls) changes.
  const [localMode, setLocalMode] = useState<string | null>(null);
  const [localCfg, setLocalCfg] = useState<Record<string, string>>({});

  // An explicit target must resolve exactly; only automatic routing falls back
  // to the primary. A missing pinned target never edits another session.
  const targetSession = resolveTargetSession(data?.sessions ?? [], selectedSessionId);
  const target = targetSession?.session_id || "";

  // New baseline → drop optimistic overlays.
  useEffect(() => {
    setLocalMode(null);
    setLocalCfg({});
  }, [target, controls]);

  if (error || !controls) return <AgentOptionsFeedback loading={loading || !error} error={error} onRetry={refresh} />;
  const hasMode = controls.allowed_modes.length > 0;

  async function apply(
    fn: () => Promise<void>,
    optimistic: () => void,
    rollback: () => void,
  ) {
    setBusy(true);
    optimistic();
    try {
      await fn();
      // Server state moved: drop the cached controls/sessions pair so the model
      // chip (and the next popover open) re-reads the effective values.
      bustBotControls(channelId, bot.botId);
      toast.success("Applied");
    } catch (e) {
      // Keep the control aligned with the server's effective value after a
      // rejected update; the overlay only exists to make successful changes
      // feel immediate.
      rollback();
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  // Effective current values: optimistic overlay → session override → bot/agent default.
  const mode = localMode ?? targetSession?.session_config?.permission_mode ?? controls.current_mode ?? "";
  const canMode = controls.can_set_mode && !!target && !loading;

  return (
    <div className="flex min-w-0 flex-col gap-3" aria-busy={loading}>
      <span className="inline-flex items-center gap-1">
        <SlidersHorizontal className={controlIconClasses.regular} />
        <span className="truncate text-regular font-semibold text-content-primary">@{bot.name}</span>
      </span>

      {!target && (
        <p className="text-regular text-content-muted" role="status">
          {selectedSessionId ? "The pinned session is unavailable. Switch sessions to change its settings." : "Start a session to change these settings."}
        </p>
      )}

      {hasMode && (
        <Field label={<span className="inline-flex items-center gap-1">Mode{!controls.can_set_mode && <Lock className={controlIconClasses.regular} aria-label="Read only" />}</span>}>
          <UiSelect
            value={mode}
            aria-label={`Mode for @${bot.name}`}
            disabled={!canMode || busy}
            controlSize="regular"
            controlWidth="fill"
            onChange={(e) => {
              const v = e.target.value;
              apply(
                () => setSessionMode(channelId, bot.botId, target, v),
                () => setLocalMode(v),
                () => setLocalMode(mode),
              );
            }}
          >
            {!mode && <option value="">—</option>}
            {!controls.allowed_modes.includes(mode) && mode && <option value={mode}>{mode}</option>}
            {controls.allowed_modes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </UiSelect>
        </Field>
      )}

      {controls.config_options.map((opt) => {
        const canCfg = controls.can_set_config_option && !!target && !loading;
        const cur =
          localCfg[opt.id] ??
          targetSession?.session_config?.config_options?.[opt.id] ??
          opt.currentValue ??
          "";
        return (
          <Field
            key={opt.id}
            label={<span className="inline-flex items-center gap-1">{opt.name}{!controls.can_set_config_option && <Lock className={controlIconClasses.regular} aria-label="Read only" />}</span>}
          >
            <UiSelect
              value={cur}
              aria-label={`${opt.name} for @${bot.name}`}
              disabled={!canCfg || busy}
              controlSize="regular"
              controlWidth="fill"
              onChange={(e) => {
                const v = e.target.value;
                apply(
                  () => setSessionConfigOption(channelId, bot.botId, target, opt.id, v),
                  () => setLocalCfg((c) => ({ ...c, [opt.id]: v })),
                  () => setLocalCfg((c) => ({ ...c, [opt.id]: cur })),
                );
              }}
            >
              {!cur && <option value="">—</option>}
              {!opt.options.some((o) => o.value === cur) && cur && <option value={cur}>{cur}</option>}
              {opt.options.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.name}
                </option>
              ))}
            </UiSelect>
          </Field>
        );
      })}
      {controls.config_options.length === 0 && <AgentOptionsFeedback loading={loading} onRetry={refresh} />}
    </div>
  );
}
