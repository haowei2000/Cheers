import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { usePopoverDismiss, PopoverPanel } from "@/components/ui/popover";
import { ComposerBotSettings, type MentionedBot } from "./ComposerBotSettings";
import { readBotControls } from "./sessionControlsCache";

/**
 * Collapsed entry point for the composer's bot model/mode + config controls.
 * The chip labels itself with the target bot's EFFECTIVE model (per-session
 * override → agent default) when it advertises one — "Sonnet 4.5" instead of a
 * generic "Model" — so the current choice is visible without opening anything.
 * With several candidate bots the label falls back to a count; with none the
 * chip disappears (an empty settings popover is dead weight).
 *
 * Opens upward (`bottom-full`) because the composer sits at the bottom of the
 * viewport. `ComposerBotSettings` (and its per-bot fetches) only mount while
 * the popover is open, so a closed composer costs one cached label read.
 */
export function ComposerModelPopover({
  channelId,
  bots,
  selectedSessionId,
}: {
  channelId: string;
  bots: MentionedBot[];
  selectedSessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);

  // The effective model label for the single target bot (null → generic "Model").
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  // Bumped by onApplied after a settings change (cache already busted).
  const [tick, setTick] = useState(0);
  const target = bots.length === 1 ? bots[0] : null;
  const targetBotId = target?.botId ?? null;

  useEffect(() => {
    setModelLabel(null);
    if (!targetBotId) return;
    let cancelled = false;
    (async () => {
      try {
        const { controls, sessions } = await readBotControls(channelId, targetBotId);
        // The agent's model knob: the option literally named "model" wins, else
        // anything model-ish (e.g. "Model preset"); none advertised → no label.
        const opt =
          controls.config_options.find((o) => o.id === "model") ??
          controls.config_options.find((o) => /model/i.test(o.name));
        if (!opt) return;
        // The session this message will hit: selected if it's this bot's, else primary.
        const targetSession =
          sessions.find((s) => s.session_id === selectedSessionId) ??
          sessions.find((s) => s.is_primary) ??
          sessions[0];
        const cur =
          targetSession?.session_config?.config_options?.[opt.id] ??
          opt.currentValue ??
          "";
        if (!cur) return;
        const human = opt.options.find((v) => v.value === cur)?.name ?? cur;
        if (!cancelled) setModelLabel(human);
      } catch {
        /* keep the generic label */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, targetBotId, selectedSessionId, tick]);

  // No candidate bot → nothing to configure; hide the chip entirely.
  if (bots.length === 0) return null;

  const label =
    bots.length > 1 ? `Model · ${bots.length} bots` : modelLabel ?? "Model";

  return (
    <div className="relative inline-flex min-w-0" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Model & bot settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 max-md:py-2 text-[11px] transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
          open
            ? "bg-indigo-600/15 text-indigo-200"
            : "bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        )}
      >
        <SlidersHorizontal className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="truncate max-w-[120px]">{label}</span>
        <ChevronDown
          className={cn("w-3 h-3 flex-shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <PopoverPanel className="min-w-[240px] max-w-[calc(100vw-2rem)] md:max-w-[420px] p-2">
          <div className="flex flex-wrap items-center gap-2">
            <ComposerBotSettings
              channelId={channelId}
              bots={bots}
              selectedSessionId={selectedSessionId}
              onApplied={() => setTick((t) => t + 1)}
            />
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}
