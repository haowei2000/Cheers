import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, Terminal, Wrench } from "lucide-react";
import toast from "react-hot-toast";
import { agentIconFor, AgentGlyph } from "@/components/ui/agentIcons";
import { invokeDesktop } from "@/lib/desktop";

/** Mirror of the Rust `DetectedAgent` (connector.rs). */
export interface DetectedAgent {
  key: string;
  label: string;
  command: string;
  installed: boolean;
  path: string | null;
  installable: boolean;
}

/**
 * Pick the agent for a connector from the ones installed on THIS machine —
 * shown as brand icons, with a one-click install for the rest. `value` is the
 * selected agent key or "custom"; `onPick` reports the chosen key plus its
 * resolved absolute command path (null when not installed / custom).
 */
export function AgentPicker({
  value,
  onPick,
}: {
  value: string;
  onPick: (key: string, commandPath: string | null) => void;
}) {
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);

  const detect = useCallback(() => {
    invokeDesktop<DetectedAgent[]>("detect_agents").then(setAgents).catch(() => {});
  }, []);
  useEffect(detect, [detect]);

  async function install(key: string) {
    setInstalling(key);
    try {
      await invokeDesktop("install_agent", { key });
      toast.success(`${key} installed`);
      detect();
    } catch (e) {
      toast.error(typeof e === "string" ? e : "install failed");
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {agents.map((a) => {
        const icon = agentIconFor(a.key);
        const selected = value === a.key;
        return (
          <div key={a.key} className="relative">
            <button
              type="button"
              disabled={!a.installed}
              title={
                a.installed
                  ? `Use ${a.label} (${a.path})`
                  : a.installable
                    ? `${a.label} isn't installed — click ↓ to install`
                    : `${a.label} can't be connected yet`
              }
              onClick={() => a.installed && onPick(a.key, a.path)}
              className={`flex flex-col items-center gap-1 w-20 rounded-xl px-2 py-2.5 transition-all ${
                selected
                  ? "ring-2 ring-indigo-500 bg-zinc-800"
                  : "bg-zinc-800/60 hover:bg-zinc-800"
              } ${a.installed ? "" : "opacity-50"}`}
            >
              <span
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{ backgroundColor: icon?.bg ?? "#3f3f46", color: icon?.fg ?? "#e4e4e7" }}
              >
                {icon ? (
                  <AgentGlyph icon={icon} className="w-[60%] h-[60%]" />
                ) : (
                  <Terminal className="w-4 h-4" />
                )}
              </span>
              <span className="text-[11px] text-zinc-300">{a.label}</span>
              <span className="text-[9px] text-zinc-500">
                {a.installed ? "installed" : a.installable ? "not installed" : "unavailable"}
              </span>
            </button>
            {!a.installed && a.installable && (
              <button
                type="button"
                title={`Install ${a.label}`}
                disabled={installing !== null}
                onClick={() => void install(a.key)}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center"
              >
                {installing === a.key ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Download className="w-3 h-3" />
                )}
              </button>
            )}
          </div>
        );
      })}
      {/* Custom command escape hatch. */}
      <button
        type="button"
        title="Use a custom command"
        onClick={() => onPick("custom", null)}
        className={`flex flex-col items-center gap-1 w-20 rounded-xl px-2 py-2.5 transition-all ${
          value === "custom"
            ? "ring-2 ring-indigo-500 bg-zinc-800"
            : "bg-zinc-800/60 hover:bg-zinc-800"
        }`}
      >
        <span className="w-8 h-8 rounded-full bg-zinc-700 text-zinc-300 flex items-center justify-center">
          <Wrench className="w-4 h-4" />
        </span>
        <span className="text-[11px] text-zinc-300">Custom</span>
        <span className="text-[9px] text-zinc-500">command</span>
      </button>
    </div>
  );
}
