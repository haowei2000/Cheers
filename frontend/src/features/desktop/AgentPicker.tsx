import { Button, Button as UiButton } from "@/components/ui/button";
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Download, Terminal, Wrench } from "lucide-react";
import toast from "react-hot-toast";
import { agentIconFor, AgentGlyph } from "@/components/ui/agentIcons";
import { invokeDesktop } from "@/lib/desktop";
import { avatarSizeClasses } from "@/components/ui/content-size";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { SearchInput } from "@/components/ui/search-input";

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
 * shown cleanly with brand icons and status, with an expandable registry catalog
 * to install additional ACP agents. `value` is the selected agent key or "custom";
 * `onPick` reports the chosen key plus its resolved absolute command path (null
 * when not installed / custom).
 */
export function AgentPicker({
  value,
  onPick,
}: {
  value: string;
  onPick: (key: string, commandPath: string | null) => void;
}) {
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [showAvailable, setShowAvailable] = useState(false);
  const [search, setSearch] = useState("");

  const detect = useCallback(async () => {
    try {
      const res = await invokeDesktop<DetectedAgent[]>("detect_agents");
      setAgents(res);
    } catch {
      // Ignore detection errors in development / non-desktop environments.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const installedAgents = agents.filter((a) => a.installed);
  const availableAgents = agents.filter((a) => !a.installed);

  // If none are installed, or if the current value is an uninstalled agent,
  // expand the registry list automatically so the selection is visible.
  useEffect(() => {
    if (!loading && agents.length > 0) {
      const hasInstalled = installedAgents.length > 0;
      const isSelectedInAvailable = availableAgents.some((a) => a.key === value);
      if (!hasInstalled || isSelectedInAvailable) {
        setShowAvailable(true);
      }
    }
  }, [loading, agents.length, installedAgents.length, availableAgents, value]);

  async function install(key: string) {
    setInstalling(key);
    try {
      await invokeDesktop("install_agent", { key });
      toast.success(`${key} installed`);
      const updated = await invokeDesktop<DetectedAgent[]>("detect_agents");
      setAgents(updated);
      const newlyInstalled = updated.find((x) => x.key === key);
      onPick(key, newlyInstalled?.path ?? null);
    } catch (e) {
      toast.error(typeof e === "string" ? e : "install failed");
    } finally {
      setInstalling(null);
    }
  }

  const filteredAvailable = search.trim()
    ? availableAgents.filter(
        (a) =>
          a.label.toLowerCase().includes(search.toLowerCase()) ||
          a.key.toLowerCase().includes(search.toLowerCase())
      )
    : availableAgents;

  return (
    <div className="space-y-3">
      {loading ? (
        <p className="text-compact text-content-muted">Detecting agents on this Mac…</p>
      ) : (
        <>
          {installedAgents.length === 0 && (
            <p className="text-compact text-content-muted">
              No ACP agents detected on this Mac. Choose an agent from the registry below to install, or use a custom command.
            </p>
          )}

          <ItemList presentationLevel="minimal" controlSize="regular">
            {installedAgents.map((a) => {
              const icon = agentIconFor(a.key) ?? agentIconFor(a.label);
              const isSelected = value === a.key;
              return (
                <OperationsItem
                  key={a.key}
                  title={a.label}
                  subtitle={a.path ?? undefined}
                  leading={
                    <span
                      data-design-system-exempt="identity"
                      className={`${avatarSizeClasses.regular} flex shrink-0 items-center justify-center rounded-full`}
                      style={{
                        backgroundColor: icon?.bg ?? "rgb(var(--tone-zinc-700))",
                        color: icon?.fg ?? "rgb(var(--text-secondary))",
                      }}
                    >
                      {icon ? (
                        <AgentGlyph icon={icon} className="w-[60%] h-[60%]" />
                      ) : (
                        <Terminal className="w-4 h-4" />
                      )}
                    </span>
                  }
                  status={
                    <span className="text-minimal text-content-muted">
                      Installed
                    </span>
                  }
                  selected={isSelected}
                  trailing={
                    isSelected ? (
                      <Check className="w-4 h-4 text-content-strong" />
                    ) : null
                  }
                  onClick={() => onPick(a.key, a.path)}
                />
              );
            })}

            {/* Custom command option. */}
            <OperationsItem
              title="Custom command"
              subtitle="Specify a custom command path and arguments"
              leading={
                <span
                  data-design-system-exempt="identity"
                  className={`${avatarSizeClasses.regular} flex shrink-0 items-center justify-center rounded-full bg-zinc-700 text-content-secondary`}
                >
                  <Wrench className="w-4 h-4" />
                </span>
              }
              selected={value === "custom" || value === "generic"}
              trailing={
                value === "custom" || value === "generic" ? (
                  <Check className="w-4 h-4 text-content-strong" />
                ) : null
              }
              onClick={() => onPick("custom", null)}
            />
          </ItemList>

          {availableAgents.length > 0 && (
            <div className="pt-1">
              <UiButton
                action={showAvailable ? "collapse" : "expand"}
                variant="plain"
                type="button"
                className="flex items-center gap-2 text-content-primary hover:text-content-strong"
                onClick={() => setShowAvailable((open) => !open)}
              >
                {showAvailable ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                <span>Available in ACP Registry ({availableAgents.length})</span>
              </UiButton>

              {showAvailable && (
                <div className="mt-2 space-y-2">
                  {availableAgents.length > 5 && (
                    <SearchInput
                      aria-label="Filter available agents"
                      placeholder="Filter registry agents…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      controlSize="compact"
                    />
                  )}

                  <div className="max-h-48 overflow-y-auto overscroll-contain rounded-sm bg-zinc-900/30">
                    {filteredAvailable.length === 0 ? (
                      <p className="p-3 text-center text-compact text-content-muted">
                        No agents match &ldquo;{search}&rdquo;
                      </p>
                    ) : (
                      <ItemList presentationLevel="minimal" controlSize="compact">
                        {filteredAvailable.map((a) => {
                          const icon = agentIconFor(a.key) ?? agentIconFor(a.label);
                          const isSelected = value === a.key;
                          return (
                            <OperationsItem
                              key={a.key}
                              title={a.label}
                              leading={
                                <span
                                  data-design-system-exempt="identity"
                                  className={`${avatarSizeClasses.small} flex shrink-0 items-center justify-center rounded-full`}
                                  style={{
                                    backgroundColor:
                                      icon?.bg ?? "rgb(var(--tone-zinc-800))",
                                    color:
                                      icon?.fg ?? "rgb(var(--text-secondary))",
                                  }}
                                >
                                  {icon ? (
                                    <AgentGlyph icon={icon} className="w-[60%] h-[60%]" />
                                  ) : (
                                    <Terminal className="w-3.5 h-3.5" />
                                  )}
                                </span>
                              }
                              selected={isSelected}
                              actions={
                                <div className="flex items-center gap-1">
                                  {a.installable && (
                                    <Button
                                      action="install"
                                      content="iconText"
                                      variant="secondary"
                                      controlSize="compact"
                                      loading={installing === a.key}
                                      disabled={installing !== null}
                                      onClick={() => void install(a.key)}
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                    </Button>
                                  )}
                                  <Button
                                    action="choose"
                                    content="text"
                                    variant={isSelected ? "primary" : "ghost"}
                                    controlSize="compact"
                                    disabled={installing !== null}
                                    onClick={() => onPick(a.key, a.path)}
                                  >
                                    {isSelected ? "Selected" : "Select"}
                                  </Button>
                                </div>
                              }
                            />
                          );
                        })}
                      </ItemList>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
