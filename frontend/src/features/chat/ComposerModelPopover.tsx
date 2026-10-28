import { ComposerToolbarButton } from "@/components/ui/composer-toolbar-button";
import { useCallback, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { usePopoverDismiss, PopoverPanel } from "@/components/ui/popover";
import { ComposerBotSettings, type MentionedBot } from "./ComposerBotSettings";
import { useBotControls, resolveTargetSession, type BotControlsEntry } from "./sessionControlsCache";
import { controlIconClasses } from "@/components/ui/control-size";

export function effectiveModelLabel(data: BotControlsEntry | undefined, selectedSessionId: string) {
  const option = data?.controls.config_options.find((opt) => opt.id === "model") ??
    data?.controls.config_options.find((opt) => opt.category === "model") ??
    data?.controls.config_options.find((opt) => /model/i.test(opt.name));
  if (!option) return null;
  const session = resolveTargetSession(data?.sessions ?? [], selectedSessionId);
  if (selectedSessionId && !session) return null;
  const value = session?.session_config?.config_options?.[option.id] ?? option.currentValue;
  return option.options.find((opt) => opt.value === value)?.name ?? value ?? null;
}

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
 * the popover is open. The label and settings share the account-owned query
 * cache, with bounded retries while discovery is empty.
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  usePopoverDismiss(open, close, rootRef, triggerRef);

  const target = bots.length === 1 ? bots[0] : null;
  const targetBotId = target?.botId ?? null;
  const { data, refresh } = useBotControls(channelId, targetBotId, selectedSessionId);
  const modelLabel = effectiveModelLabel(data, selectedSessionId);

  // No candidate bot → nothing to configure; hide the chip entirely.
  if (bots.length === 0) return null;

  const currentValue =
    bots.length > 1 ? `${bots.length} bots` : modelLabel || "Model";

  return (
    <div className="relative inline-flex shrink-0" ref={rootRef}>
      <ComposerToolbarButton
        ref={triggerRef}
        type="button"
        selected={open}
        onClick={() => { if (!open) refresh(); setOpen((o) => !o); }}
        title={`Model & bot settings · ${currentValue}`}
        aria-label={`Model and bot settings: ${currentValue}`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="min-w-0 flex-1 truncate">{currentValue}</span>
        <ChevronDown
          className={cn(controlIconClasses.regular, "shrink-0 transition-transform", open && "rotate-180")}
        />
      </ComposerToolbarButton>

      {open && (
        <PopoverPanel align="end" className="w-80 max-w-[calc(100vw-2rem)] max-h-[min(70vh,28rem)] overflow-y-auto p-3">
          <div className="flex flex-col gap-4" role="dialog" aria-label="Model and bot settings">
            <ComposerBotSettings
              channelId={channelId}
              bots={bots}
              selectedSessionId={selectedSessionId}
            />
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}
