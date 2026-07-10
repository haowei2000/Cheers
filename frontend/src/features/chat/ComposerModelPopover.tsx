import { useEffect, useState } from "react";
import { SlidersHorizontal, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { ComposerBotSettings, type MentionedBot } from "./ComposerBotSettings";

/**
 * Collapsed entry point for the composer's bot model/mode + config controls.
 * The controls used to sit inline in the composer toolbar, always visible; most
 * sends never touch them, so they're now behind a "Model" button that opens a
 * popover on click. Bonus: `ComposerBotSettings` (and its per-bot session-control
 * fetches) only mount while the popover is open, so a closed composer makes no
 * requests.
 *
 * Opens upward (`bottom-full`) because the composer sits at the bottom of the
 * viewport. Closes on outside click / Escape via document listeners, ignoring
 * clicks inside `[data-composer-model-root]` so the toggle button doesn't
 * close-then-reopen (same pattern as MembersPopover).
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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-composer-model-root]"))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-flex" data-composer-model-root>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Model & bot settings"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition-colors",
          open
            ? "bg-indigo-600/15 text-indigo-200"
            : "bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        )}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        <span>Model</span>
        <ChevronDown
          className={cn("w-3 h-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 z-50 min-w-[240px] max-w-[420px] rounded-xl border border-zinc-800 bg-zinc-900 p-2 shadow-xl">
          {bots.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <ComposerBotSettings
                channelId={channelId}
                bots={bots}
                selectedSessionId={selectedSessionId}
              />
            </div>
          ) : (
            <p className="px-1 py-1 text-[11px] text-zinc-600">
              No bot in this channel to configure.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
