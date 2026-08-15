import { Button as UiButton } from "@/components/ui/button";
import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, Terminal, Wrench } from "lucide-react";
import toast from "react-hot-toast";
import { agentIconFor, AgentGlyph } from "@/components/ui/agentIcons";
import { invokeDesktop } from "@/lib/desktop";
import { avatarSizeClasses } from "@/components/ui/content-size";

/** Mirror of the Rust `DetectedAgent` (connector.rs). */
export interface DetectedAgent {
  key: string;
  label: string;
  command: string;
  args?: string[];
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
    <div className="max-h-56 overflow-y-auto overscroll-contain">
      <div className="flex flex-wrap gap-2">
      {agents.map((a) => {
        const icon = agentIconFor(a.key) ?? agentIconFor(a.label);
        const selected = value === a.key;
        return (
          <div key={a.key} className="relative">
            <UiButton action="install" variant="plain"
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
              controlSize="regular" className={`flex flex-col items-center gap-1 rounded-sm transition-all ${
 selected
 ? "ring-2 ring-indigo-500 bg-zinc-800": "bg-zinc-800/60 hover:bg-zinc-800"
 } ${a.installed ? "" : "opacity-50"}`}
            >
              <span
                data-design-system-exempt="identity"
                className={`${avatarSizeClasses.regular} flex shrink-0 items-center justify-center rounded-full`}
                style={{ backgroundColor: icon?.bg ?? "#3f3f46", color: icon?.fg ?? "#e4e4e7" }}
              >
                {icon ? (
                  <AgentGlyph icon={icon} className="w-[60%] h-[60%]" />
                ) : (
                  <Terminal className="w-4 h-4" />
                )}
              </span>
              <span className="text-compact text-content-secondary truncate w-full text-center">
                {a.label}
              </span>
              <span className="text-minimal text-content-muted">
                {a.installed ? "installed" : a.installable ? "not installed" : "unavailable"}
              </span>
            </UiButton>
            {!a.installed && a.installable && (
              <UiButton variant="plain"
                type="button"
                title={`Install ${a.label}`}
                disabled={installing !== null}
                onClick={() => void install(a.key)}
                content="icon" controlSize="compact" className="absolute -top-1 -right-1 rounded-sm bg-indigo-600 hover:bg-indigo-500 text-content-on-accent flex items-center justify-center"
              >
                {installing === a.key ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
              </UiButton>
            )}
          </div>
        );
      })}
      {/* Custom command escape hatch. */}
      <UiButton action="choose" variant="plain"
        type="button"
        title="Use a custom command"
        onClick={() => onPick("custom", null)}
        controlSize="regular" className={`flex flex-col items-center gap-1 rounded-sm transition-all ${
 value === "custom"? "ring-2 ring-indigo-500 bg-zinc-800"
 : "bg-zinc-800/60 hover:bg-zinc-800"
 }`}
      >
        <span data-design-system-exempt="identity" className={`${avatarSizeClasses.regular} flex items-center justify-center rounded-full bg-zinc-700 text-content-secondary`}>
          <Wrench className="w-4 h-4" />
        </span>
        <span className="text-compact text-content-secondary">Custom</span>
        <span className="text-minimal text-content-muted">command</span>
      </UiButton>
      </div>
    </div>
  );
}
