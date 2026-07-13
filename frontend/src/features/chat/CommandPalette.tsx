// ⑦ Command palette — the "/" picker for the composer, mirroring the "@" mention
// picker's look and keyboard model. Commands are advertised by the channel's bots
// (ACP `available_commands_update`, surfaced via `channel.commands.read`), so both
// the name and the description are AGENT-PRODUCED and UNTRUSTED: they render as
// inert text only — never as HTML.
import { Fragment } from "react";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/cn";

export interface CommandCandidate {
  /** The command name as advertised, e.g. "review" — inserted as "/review ". */
  name: string;
  /** Optional one-line description (agent-produced, shown inert). */
  description?: string;
  /** The bot that advertised it, so the same name from two bots stays distinct. */
  botId: string;
  /** Display label for the advertising bot (falls back to a short id). */
  botLabel: string;
}

interface Props {
  commands: CommandCandidate[];
  activeIndex: number;
  onSelect: (c: CommandCandidate) => void;
  /** Multi-bot channels: rows arrive sorted by bot; render a header per bot run
      (inert text — bot labels are agent-influenced) instead of per-row badges. */
  grouped?: boolean;
}

/**
 * The floating list shown above the composer while a "/" token is being typed.
 * Positioning + visibility are owned by the composer; this only renders the rows.
 */
export function CommandPalette({ commands, activeIndex, onSelect, grouped }: Props) {
  return (
    <div className="absolute bottom-full left-4 right-4 mb-2 max-h-60 overflow-y-auto rounded-lg bg-zinc-900 shadow-xl shadow-black/40 z-20">
      {commands.map((c, i) => (
        <Fragment key={`${c.botId}/${c.name}`}>
          {grouped && (i === 0 || commands[i - 1].botId !== c.botId) && (
            <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              {c.botLabel}
            </div>
          )}
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(c);
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
              i === activeIndex
                ? "bg-indigo-600/30 text-zinc-100"
                : "text-zinc-300 hover:bg-zinc-800"
            )}
          >
            <Terminal className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span className="font-medium font-mono">/{c.name}</span>
            {c.description && (
              <span className="text-xs text-zinc-400 truncate">
                {c.description}
              </span>
            )}
            {!grouped && (
              <span className="ml-auto text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 flex-shrink-0">
                {c.botLabel}
              </span>
            )}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
