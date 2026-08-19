import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  Loader2,
  Laptop,
  Play,
  Plus,
  RotateCw,
  Settings2,
  Square,
  Ticket,
  Trash2,
} from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Dialog } from "@/components/ui/dialog";
import { WorkbenchItem } from "@/components/ui/item";
import { PresenceDot } from "@/components/ui/presence-dot";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { invokeDesktop } from "@/lib/desktop";
import {
  connectorHealth,
  connectorAuditTimeline,
  connectorAddAllowedRoots,
  onFileDrop,
  type ConnectorHealth,
  type AuditEvent,
} from "@/lib/desktopConnector";
import { isTauri } from "@/lib/serverConfig";
import { ConnectorConfigForm } from "./ConnectorConfigForm";
import { ConnectorChanges } from "./ConnectorChanges";
import { AgentUpdates } from "./AgentUpdates";
import { AgentPicker, type DetectedAgent } from "./AgentPicker";
import { consumeConnectorIntent } from "./connectorIntent";
import { createInstallation, listBots, redeemInstallationPairing, type AgentType } from "@/api/bots";
import type { BotItem } from "@/types";

/** Shape returned by the Tauri `connector_list` command (src-tauri/src/connector.rs). */
interface ConnectorInstance {
  name: string;
  running: boolean;
  pid: number | null;
  started_at: string | null;
  config_path: string | null;
  stdout_log: string | null;
  start_with_app: boolean;
}

/** Local workspace dirs from `connector_roots` (daemon cwd + config roots). */
interface ConnectorRoots {
  cwd: string | null;
  roots: string[];
}

/** An app that can open a workspace dir (Finder + installed editors). */
interface Opener {
  key: string;
  label: string;
}

/** Which detail panel is open, as a modal. */
type Modal =
  | { kind: "onboard" }
  | { kind: "redeem" }
  | {
      kind: "logs" | "workspace" | "edit" | "delete" | "changes" | "audit";
      inst: ConnectorInstance;
    }
  | null;

const POLL_MS = 5000;

function fmtMem(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Non-empty Installation agent id (legacy short name or registry id). */
function isAgentType(v: string | undefined): v is AgentType {
  return !!v && v.trim().length > 0;
}

/** Install any registry/builtin agent that is missing but installable.
 *  Auth is handled generically by the connector via ACP `authenticate`
 *  after initialize — not here. */
async function ensureAdapterReady(agentType: AgentType): Promise<boolean> {
  try {
    const agents = await invokeDesktop<DetectedAgent[]>("detect_agents");
    const a = agents.find((x) => x.key === agentType);
    if (!a) return true;
    if (a.installed) return true;
    if (!a.installable) {
      toast.error(
        `${a.label} isn't installed on this Mac and can't be auto-installed — install it manually, then try again`
      );
      return false;
    }
    const toastId = toast.loading(`Installing ${a.label}…`);
    try {
      await invokeDesktop("install_agent", { key: agentType });
      toast.success(`${a.label} installed`, { id: toastId });
      return true;
    } catch (e) {
      const detail = typeof e === "string" ? e : "install failed";
      toast.error(detail, { id: toastId });
      return false;
    }
  } catch {
    return true;
  }
}

/** CPU/mem line + an amber "consider restart" badge when a connector looks
 *  hung/runaway. Restart routes through the existing connector_restart. */
function HealthRow({
  h,
  onRestart,
  busy,
}: {
  h: ConnectorHealth;
  onRestart: () => void;
  busy: boolean;
}) {
  const reason =
    h.status === "high_cpu"
      ? "High CPU"
      : h.status === "high_mem"
        ? "High memory"
        : h.status === "stuck"
          ? "Not responding"
          : "";
  return (
    <div className="flex items-center gap-2 text-compact min-w-0">
      <span className="text-content-muted tabular-nums shrink-0">
        {h.cpu_pct.toFixed(0)}% CPU · {fmtMem(h.mem_bytes)}
      </span>
      {reason && (
        <UiButton action="restart" variant="plain"
          type="button"
          onClick={onRestart}
          disabled={busy}
          title={`${reason} — restart this installation`}
          controlSize="regular" className="inline-flex items-center gap-1 rounded-sm bg-amber-950/60 text-warning-300 hover:bg-amber-900/60 disabled:opacity-50 min-w-0"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{reason} · Restart</span>
        </UiButton>
      )}
    </div>
  );
}

/** Icon-only action button with a hover tooltip. */
function IconBtn({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <UiButton variant="plain"
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      content="icon" controlSize="regular" className={`rounded-sm flex items-center justify-center transition-colors disabled:opacity-50 ${
 danger
 ? "text-removed-400 hover:bg-rose-950/50"
 : "text-content-primary hover:bg-zinc-700"
 }`}
    >
      {icon}
    </UiButton>
  );
}

/** Desktop-shell only: manage local `cce-acp-connector` daemons — the
 * graphical replacement for the CLI start/stop/status/logs loop. Instance
 * state comes from the connector's own daemon.json via the Rust side. */
export function ConnectorManager() {
  const [instances, setInstances] = useState<ConnectorInstance[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [logs, setLogs] = useState("");
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [health, setHealth] = useState<Record<string, ConnectorHealth>>({});
  const [roots, setRoots] = useState<ConnectorRoots | null>(null);
  const [openers, setOpeners] = useState<Opener[]>([]);
  const [keepConfig, setKeepConfig] = useState(false);
  // Card highlighted while a Finder folder is dragged over it (drag-to-grant).
  const [dragOverName, setDragOverName] = useState<string | null>(null);
  // Installation setup always starts from an existing bot identity.
  const [bots, setBots] = useState<BotItem[]>([]);
  const [existingBotId, setExistingBotId] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("codex");
  const [onboarding, setOnboarding] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  // Advanced fallback: start straight from an existing .toml on disk.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newConfig, setNewConfig] = useState("");

  const refresh = useCallback(() => {
    invokeDesktop<ConnectorInstance[]>("connector_list")
      .then(async (list) => {
        setInstances(list);
        // Health is per-connector (daemon+adapter process group); sample the
        // running ones and keep a name→health map for the cards.
        const rec: Record<string, ConnectorHealth> = {};
        await Promise.all(
          list
            .filter((i) => i.running)
            .map(async (i) => {
              const h = await connectorHealth(i.name).catch(() => null);
              if (h) rec[i.name] = h;
            })
        );
        setHealth(rec);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Drag-to-grant: drop a Finder folder onto a connector card → append it to
  // that connector's allowed_roots (reusing the config write path) + restart the
  // daemon so the new root takes effect. Tauri gives absolute paths + a physical
  // cursor position; we hit-test it to the card under the pointer.
  const grantRoots = useCallback(
    async (name: string, paths: string[]) => {
      setBusy(name);
      try {
        // The Rust side appends to allowed_roots (skipping non-dirs/dupes) and
        // restarts the daemon itself if it's running — no separate restart here.
        await connectorAddAllowedRoots(name, paths);
        toast.success(`Added ${paths.length} folder(s) to "${name}"`);
      } catch (e) {
        toast.error(typeof e === "string" ? e : "couldn't grant folder");
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh]
  );

  useEffect(() => {
    let unlisten = () => {};
    let cancelled = false;
    const cardAt = (x: number, y: number) =>
      (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(
        "[data-connector-drop]"
      ) ?? null;
    void onFileDrop((e) => {
      if (e.type === "leave") return setDragOverName(null);
      if (e.type === "drop") {
        setDragOverName(null);
        const card = cardAt(e.x, e.y);
        // Only cards with a config are droppable (roots live in the config).
        if (!card || !card.dataset.connectorConfig) return;
        void grantRoots(card.dataset.connectorName ?? "", e.paths);
        return;
      }
      // enter / over: highlight only a droppable (has-config) card.
      const card = cardAt(e.x, e.y);
      setDragOverName(card?.dataset.connectorConfig ? card.dataset.connectorName ?? null : null);
    }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten();
    };
  }, [grantRoots]);

  // Which apps can open a folder here (Finder + installed editors); probed once.
  useEffect(() => {
    invokeDesktop<Opener[]>("available_openers")
      .then(setOpeners)
      .catch(() => setOpeners([{ key: "finder", label: "Finder" }]));
  }, []);

  // The user's manageable bots, for the "existing bot" onboarding option. Also
  // honors a hand-off from the "new bot → Set up on this Mac" flow: open the
  // New-connector modal immediately (don't wait on the bots fetch) with that
  // bot preselected.
  useEffect(() => {
    const intent = consumeConnectorIntent();
    const wantBot = intent?.botId;
    if (intent) {
      setExistingBotId(intent.botId);
      // Honour the agent type the wizard already asked about, so the hand-off
      // doesn't quietly re-default to this component's own initial value.
      if (intent.agentType) setAgentType(intent.agentType);
      setModal({ kind: "onboard" });
    }
    listBots()
      .then((all) => {
        const mine = all.filter((b) => b.can_manage);
        setBots(mine);
        // Preselect the handed-off bot if present, else the first bot — but
        // never clobber a handed-off selection the modal is already showing.
        if (wantBot && mine.some((b) => b.bot_id === wantBot)) {
          setExistingBotId(wantBot);
        } else if (!wantBot && mine[0]) {
          setExistingBotId(mine[0].bot_id);
        }
      })
      .catch(() => {});
  }, []);

  // Deep links from the Fleet create menu land directly in the pairing flow.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("redeem")) {
      setModal({ kind: "redeem" });
    }
  }, []);

  async function act(
    name: string,
    action: () => Promise<unknown>,
    done: string
  ): Promise<boolean> {
    setBusy(name);
    try {
      await action();
      toast.success(done);
      return true;
    } catch (e) {
      toast.error(typeof e === "string" ? e : e instanceof Error ? e.message : "failed");
      return false;
    } finally {
      setBusy(null);
      refresh();
    }
  }

  // ── redeem a pairing code created elsewhere ───────────────────────────────
  // The bot already exists and someone else picked its agent; this Mac only
  // supplies the host. The adapter pre-flight therefore reads the agent type
  // out of the redeemed config rather than from this component's picker.
  async function redeemCode() {
    const code = pairingCode.trim();
    if (!code) {
      toast.error("Paste the code first");
      return;
    }
    setOnboarding(true);
    try {
      const redeemed = await redeemInstallationPairing(code, "Cheers Desktop");
      if (isAgentType(redeemed.agent_type) && !(await ensureAdapterReady(redeemed.agent_type))) {
        // The code is spent and the Installation is active by now, so redemption
        // can't be undone. Say so plainly instead of a bare "not installed",
        // because the user's next step is to install and mint a fresh code.
        toast.error(
          `This bot needs the ${redeemed.agent_type} adapter. Install failed or isn't available — ask for a new code after installing.`
        );
        return;
      }
      const configPath = await invokeDesktop<string>("connector_write_onboarded", {
        accountId: redeemed.account_id,
        configToml: redeemed.config_toml,
        token: redeemed.credential,
        tokenFile: redeemed.credential_file,
      });
      await invokeDesktop("connector_start", { name: redeemed.account_id, configPath });
      toast.success(`Installation "${redeemed.account_id}" is running`);
      setPairingCode("");
      setModal(null);
      refresh();
    } catch (e) {
      toast.error(
        typeof e === "string" ? e : e instanceof Error ? e.message : "couldn't use that code"
      );
    } finally {
      setOnboarding(false);
    }
  }

  // ── onboarding (the New tile) ──────────────────────────────────────────────
  async function onboard() {
    setOnboardingError(null);
    setOnboarding(true);
    try {
      // Pre-flight the adapter before creating a pending installation, so an
      // unavailable local agent does not leave a pairing behind.
      if (!(await ensureAdapterReady(agentType))) {
        return;
      }

      const botId = existingBotId;
      if (!botId) {
        toast.error("Pick a bot first");
        return;
      }
      const pairing = await createInstallation(botId, agentType, "Cheers Desktop");
      const redeemed = await redeemInstallationPairing(pairing.pairing_code, "Cheers Desktop");
      const configPath = await invokeDesktop<string>("connector_write_onboarded", {
        accountId: redeemed.account_id,
        configToml: redeemed.config_toml,
        token: redeemed.credential,
        tokenFile: redeemed.credential_file,
      });
      await invokeDesktop("connector_start", { name: redeemed.account_id, configPath });
      toast.success(`Installation "${redeemed.account_id}" is running`);
      setModal(null);
      refresh();
    } catch (e) {
      const detail =
        typeof e === "string" ? e : e instanceof Error ? e.message : "onboarding failed";
      setOnboardingError(detail);
      toast.error(detail);
    } finally {
      setOnboarding(false);
    }
  }

  // ── detail openers (each shows a modal) ────────────────────────────────────
  async function openLogs(inst: ConnectorInstance) {
    setModal({ kind: "logs", inst });
    setLogs("Loading…");
    try {
      setLogs(await invokeDesktop<string>("connector_logs", { name: inst.name, lines: 200 }));
    } catch (e) {
      setLogs(typeof e === "string" ? e : "couldn't read logs");
    }
  }

  async function openWorkspace(inst: ConnectorInstance) {
    setModal({ kind: "workspace", inst });
    setRoots(null);
    try {
      setRoots(await invokeDesktop<ConnectorRoots>("connector_roots", { name: inst.name }));
    } catch {
      setRoots({ cwd: null, roots: [] });
    }
  }

  async function openAudit(inst: ConnectorInstance) {
    setModal({ kind: "audit", inst });
    setAudit(null);
    try {
      setAudit(await connectorAuditTimeline(inst.name, 500));
    } catch {
      setAudit([]);
    }
  }

  async function openWith(name: string, path: string, opener: string) {
    try {
      await invokeDesktop("open_path", { name, path, opener });
    } catch (e) {
      toast.error(typeof e === "string" ? e : "couldn't open the path");
    }
  }

  async function saveConfigForm(
    inst: ConnectorInstance,
    restart: boolean,
    apply: () => Promise<unknown>
  ) {
    setBusy(inst.name);
    try {
      await apply();
      if (restart && inst.running) {
        await invokeDesktop("connector_restart", { name: inst.name });
        toast.success("Config saved, installation restarted");
      } else {
        toast.success("Config saved");
      }
      setModal(null);
    } catch (e) {
      toast.error(typeof e === "string" ? e : e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(null);
      refresh();
    }
  }

  const wsDirs = roots ? (roots.cwd ? [roots.cwd] : []).concat(roots.roots.filter((r) => r !== roots.cwd)) : [];

  return (
    <section>
      <h2 className="text-compact font-semibold text-content-muted uppercase tracking-section mb-4 flex items-center gap-2">
        <Laptop className="w-3.5 h-3.5" />
        Installations
      </h2>

      <div className="bg-zinc-900 rounded-sm p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-regular font-medium text-content-secondary">Bots installed on this Mac</p>
            <p className="mt-1 text-compact text-content-muted">
              Local connector processes. Registered devices and credentials are listed above.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <UiButton action="setup" content="iconText" variant="secondary" controlSize="compact" onClick={() => setModal({ kind: "onboard" })}>
              <Plus className="h-4 w-4" />
            </UiButton>
            <UiButton action="setup" content="icon" variant="plain" controlSize="compact" aria-label="Use pairing code" title="Use pairing code" onClick={() => setModal({ kind: "redeem" })}>
              <Ticket className="h-4 w-4" />
            </UiButton>
          </div>
        </div>

        {instances.length === 0 && (
          <p className="mb-3 rounded-sm bg-zinc-800/60 px-3 py-4 text-compact text-content-muted">
            No connector is running on this Mac. Add an installation or use a pairing code.
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {instances.map((inst) => (
            <div
              key={inst.name}
              data-connector-drop=""
              data-connector-name={inst.name}
              data-connector-config={inst.config_path ?? ""}
              data-connector-running={inst.running ? "1" : ""}
              className={`min-h-[132px] rounded-sm bg-zinc-800/60 p-3 flex flex-col gap-2 transition-shadow ${
                dragOverName === inst.name ? "ring-2 ring-indigo-500 bg-indigo-950/20" : ""
              }`}
            >
              <WorkbenchItem
                presentationLevel="medium"
                leading={<PresenceDot
                  contentSize="regular"
                  className={inst.running ? "bg-emerald-500" : "bg-zinc-600"}
                  title={inst.running ? "running" : "stopped"}
                />}
                title={inst.name}
                status={<span className="truncate text-compact text-content-muted">
                  {inst.running ? `running · pid ${inst.pid}` : inst.config_path ? "stopped" : "stopped · no config"}
                </span>}
                className="border-b-0 bg-transparent"
              />

              {inst.running && health[inst.name] && (
                <HealthRow
                  h={health[inst.name]}
                  busy={busy === inst.name}
                  onRestart={() =>
                    void act(
                      inst.name,
                      () => invokeDesktop("connector_restart", { name: inst.name }),
                      "Installation restarted"
                    )
                  }
                />
              )}

              <div className="flex items-center gap-1 flex-wrap mt-auto">
                {inst.running ? (
                  <IconBtn
                    icon={<Square className="w-4 h-4" />}
                    label="Stop"
                    disabled={busy === inst.name}
                    onClick={() =>
                      void act(
                        inst.name,
                        () => invokeDesktop("connector_stop", { name: inst.name }),
                        "Installation stopped"
                      )
                    }
                  />
                ) : (
                  <IconBtn
                    icon={<Play className="w-4 h-4" />}
                    label="Start"
                    disabled={busy === inst.name || !inst.config_path}
                    onClick={() =>
                      void act(
                        inst.name,
                        () =>
                          invokeDesktop("connector_start", {
                            name: inst.name,
                            configPath: inst.config_path,
                          }),
                        "Installation started"
                      )
                    }
                  />
                )}
                <IconBtn
                  icon={<RotateCw className="w-4 h-4" />}
                  label="Restart"
                  disabled={busy === inst.name}
                  onClick={() =>
                    void act(
                      inst.name,
                      () => invokeDesktop("connector_restart", { name: inst.name }),
                      "Installation restarted"
                    )
                  }
                />
                <IconBtn
                  icon={<FileText className="w-4 h-4" />}
                  label="Logs"
                  onClick={() => void openLogs(inst)}
                />
                <IconBtn
                  icon={<GitBranch className="w-4 h-4" />}
                  label="Changes"
                  onClick={() => setModal({ kind: "changes", inst })}
                />
                <IconBtn
                  icon={<History className="w-4 h-4" />}
                  label="Audit timeline"
                  onClick={() => void openAudit(inst)}
                />
                <IconBtn
                  icon={<FolderOpen className="w-4 h-4" />}
                  label="Open workspace"
                  onClick={() => void openWorkspace(inst)}
                />
                <IconBtn
                  icon={<Settings2 className="w-4 h-4" />}
                  label="Edit config"
                  disabled={!inst.config_path}
                  onClick={() => setModal({ kind: "edit", inst })}
                />
                <IconBtn
                  icon={<Trash2 className="w-4 h-4" />}
                  label="Delete"
                  danger
                  disabled={busy === inst.name}
                  onClick={() => {
                    setKeepConfig(false);
                    setModal({ kind: "delete", inst });
                  }}
                />
              </div>

              <CheckboxField
                label="Start with app"
                checked={inst.start_with_app}
                onChange={(e) =>
                  void act(
                    inst.name,
                    () =>
                      invokeDesktop("connector_set_start_with_app", {
                        name: inst.name,
                        enabled: e.target.checked,
                      }),
                    e.target.checked ? "Will start with app" : "Won't start with app"
                  )
                }
                controlSize="compact"
                className="text-compact text-content-muted"
              />
            </div>
          ))}
        </div>
      </div>

      {/* ── Modals ── */}
      {modal?.kind === "redeem" && (
        <Dialog title="I have a code" onClose={() => setModal(null)} maxWidth="max-w-lg">
          <div className="space-y-3">
            <p className="text-compact text-content-muted">
              Paste the one-time code from wherever the bot was created — the
              Cheers app on your phone, the web UI, or a teammate. This Mac
              becomes the machine that runs it.
            </p>
            <UiInput
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value)}
              placeholder="agbpair_…"
              autoFocus
              spellCheck={false}
              controlSize="regular" className="rounded-sm bg-zinc-800 text-regular font-code text-content-primary placeholder:text-content-muted outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <p className="text-compact text-content-muted">
              Codes are single-use and expire after about 15 minutes. Using one
              activates this installation, so the bot's previously active
              installation will stop.
            </p>
            <div className="flex justify-end gap-2">
              <Button action="cancel" variant="secondary" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button action="setup" onClick={() => void redeemCode()} disabled={onboarding}>
                {onboarding && <Loader2 className="w-4 h-4 animate-spin" />}
                Set up & start
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {modal?.kind === "onboard" && (
        <Dialog title="Add an installation on this Mac" onClose={() => setModal(null)} maxWidth="max-w-lg">
          <OnboardForm
            bots={bots}
            existingBotId={existingBotId}
            setExistingBotId={setExistingBotId}
            agentType={agentType}
            setAgentType={setAgentType}
            onboarding={onboarding}
            onboardingError={onboardingError}
            onSubmit={() => void onboard()}
            advancedOpen={advancedOpen}
            setAdvancedOpen={setAdvancedOpen}
            newName={newName}
            setNewName={setNewName}
            newConfig={newConfig}
            setNewConfig={setNewConfig}
            busy={busy !== null}
            startFromToml={() =>
              void act(
                newName.trim(),
                () =>
                  invokeDesktop("connector_start", {
                    name: newName.trim(),
                    configPath: newConfig.trim(),
                  }),
                "Installation started"
              ).then((ok) => {
                if (!ok) return;
                setNewName("");
                setNewConfig("");
                setModal(null);
              })
            }
          />
        </Dialog>
      )}

      {modal?.kind === "logs" && (
        <Dialog title={`Logs — ${modal.inst.name}`} onClose={() => setModal(null)} maxWidth="max-w-2xl">
          <div className="flex justify-end mb-1">
            <UiButton action="refresh" variant="plain"
              type="button"
              className=" text-content-primary hover:text-content-strong"
              onClick={() => void openLogs(modal.inst)}
            >
              Refresh
            </UiButton>
          </div>
          <pre className="text-compact bg-zinc-950 rounded-sm p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap text-content-secondary">
            {logs}
          </pre>
        </Dialog>
      )}

      {modal?.kind === "workspace" && (
        <Dialog title={`Workspace — ${modal.inst.name}`} onClose={() => setModal(null)} maxWidth="max-w-lg">
          <p className="text-compact text-content-muted mb-3">
            Open the agent's own directories in a local editor or Finder — only
            this desktop app can reach your disk.
          </p>
          {roots === null ? (
            <p className="text-compact text-content-muted">Loading…</p>
          ) : wsDirs.length === 0 ? (
            <p className="text-compact text-content-muted">
              No workspace roots on disk (check the config's{" "}
              <code className="bg-zinc-800 rounded-sm px-1">[policy.workspace]</code>).
            </p>
          ) : (
            <div className="space-y-3">
              {/* design-system-exempt: item-section — filesystem root grouping. */}
              {wsDirs.map((dir) => (
                <div key={dir}>
                  <div className="flex items-center gap-2 mb-1">
                    <FolderOpen className="w-3.5 h-3.5 shrink-0 text-content-muted" />
                    <span
                      className="truncate text-compact text-content-secondary min-w-0"
                      dir="rtl"
                      style={{ unicodeBidi: "plaintext" }}
                      title={dir}
                    >
                      {dir}
                    </span>
                    {dir === roots?.cwd && (
                      <span className="text-minimal text-content-muted shrink-0">cwd</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 pl-5">
                    {/* design-system-exempt: menu-option — opener command menu. */}
                    {openers.map((op) => (
                      <UiButton variant="plain" role="menuitem"
                        key={op.key}
                        type="button"
                        controlSize="regular" className=" rounded-sm bg-zinc-800 hover:bg-zinc-700 text-content-primary transition-colors"
                        onClick={() => void openWith(modal.inst.name, dir, op.key)}
                      >
                        {op.label}
                      </UiButton>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Dialog>
      )}

      {modal?.kind === "changes" && (
        <Dialog
          title={`Changes — ${modal.inst.name}`}
          onClose={() => setModal(null)}
          maxWidth="max-w-3xl"
        >
          <ConnectorChanges name={modal.inst.name} openers={openers} />
        </Dialog>
      )}

      {modal?.kind === "audit" && (
        <Dialog
          title={`Audit timeline — ${modal.inst.name}`}
          onClose={() => setModal(null)}
          maxWidth="max-w-2xl"
        >
          <AuditTimeline events={audit} onRefresh={() => void openAudit(modal.inst)} />
        </Dialog>
      )}

      {modal?.kind === "edit" && modal.inst.config_path && (
        <Dialog title={`Edit config — ${modal.inst.name}`} onClose={() => setModal(null)} maxWidth="max-w-2xl">
          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <ConnectorConfigForm
              name={modal.inst.name}
              configPath={modal.inst.config_path}
              busy={busy === modal.inst.name}
              onClose={() => setModal(null)}
              onSave={(restart, apply) => void saveConfigForm(modal.inst, restart, apply)}
            />
          </div>
        </Dialog>
      )}

      {modal?.kind === "delete" && (
        <Dialog title="Remove local installation" onClose={() => setModal(null)} maxWidth="max-w-md">
          <p className="text-regular text-content-secondary">
            Remove the local installation <b>{modal.inst.name}</b> (stops it and
            deletes its state, logs, and config). This does <b>not</b> delete the
            bot on the server — do that from the web Bots settings.
          </p>
          <CheckboxField
            label={
              <>
                Keep a backup of the config as{" "}
                <code className="bg-zinc-800 rounded-sm px-1">.toml.kept</code> (won&apos;t
                show in the list)
              </>
            }
            checked={keepConfig}
            onChange={(e) => setKeepConfig(e.target.checked)}
            controlSize="compact"
            className="mt-3 text-compact text-content-muted"
          />
          <div className="flex gap-2 mt-4">
            <Button action="delete"
              variant="danger"
              controlSize="compact"
              className="bg-red-950/70 hover:bg-red-900/80 text-danger-300"
              disabled={busy === modal.inst.name}
              onClick={() =>
                void act(
                  modal.inst.name,
                  () =>
                    invokeDesktop("connector_delete", {
                      name: modal.inst.name,
                      deleteConfig: !keepConfig,
                    }),
                  "Installation removed"
                ).then((ok) => ok && setModal(null))
              }
            >
              Remove installation
            </Button>
            <Button action="cancel" variant="secondary" controlSize="compact" onClick={() => setModal(null)}>
              Cancel
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

const AUDIT_META: Record<AuditEvent["kind"], { label: string; dot: string }> = {
  lifecycle: { label: "Lifecycle", dot: "bg-zinc-500" },
  prompt: { label: "Prompt", dot: "bg-indigo-400" },
  command: { label: "Command", dot: "bg-amber-400" },
  file_write: { label: "File write", dot: "bg-sky-400" },
  tool_call: { label: "Tool call", dot: "bg-teal-400" },
  permission_request: { label: "Permission ask", dot: "bg-violet-400" },
  permission_decision: { label: "Decision", dot: "bg-emerald-400" },
  resource_request: { label: "Resource", dot: "bg-zinc-500" },
  error: { label: "Error", dot: "bg-rose-500" },
};

/** Read-only audit timeline over an instance's stdout log. Filter chips toggle
 *  kinds; rows with detail expand. Purely a display of what the daemon logged —
 *  no message or permission action is taken here (that stays on the gateway). */
function AuditTimeline({
  events,
  onRefresh,
}: {
  events: AuditEvent[] | null;
  onRefresh: () => void;
}) {
  const [hidden, setHidden] = useState<Set<AuditEvent["kind"]>>(new Set());
  if (events === null) return <p className="text-compact text-content-muted">Loading…</p>;
  const kinds = Array.from(new Set(events.map((e) => e.kind)));
  const shown = events.filter((e) => !hidden.has(e.kind));
  const toggle = (k: AuditEvent["kind"]) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* design-system-exempt: menu-option — audit kind filters. */}
        {kinds.map((k) => (
          <UiButton action="switch" content="iconText" variant="plain"
            key={k}
            type="button"
            onClick={() => toggle(k)}
            controlSize="regular" className={` rounded-sm transition-colors ${
 hidden.has(k) ? "bg-zinc-800 text-content-primary": "bg-zinc-700 text-content-primary"
 }`}
          >
            <PresenceDot contentSize="small" className={`mr-1 align-middle ${AUDIT_META[k].dot}`} />
            {AUDIT_META[k].label}
          </UiButton>
        ))}
        <UiButton action="refresh" variant="plain"
          type="button"
          onClick={onRefresh}
          className=" text-content-primary hover:text-content-strong ml-auto"
        >
          Refresh
        </UiButton>
      </div>
      {shown.length === 0 ? (
        <p className="text-compact text-content-muted">
          No audit events yet. Advanced per-command and file detail requires{" "}
          <code className="bg-zinc-800 rounded-sm px-1">RUST_LOG=debug</code>; default logs still show
          restarts, permission asks/decisions and errors.
        </p>
      ) : (
        <div className="space-y-2 max-h-[60vh] overflow-auto pr-1" role="list">
          {shown.map((e, i) => (
            <AuditRow key={i} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function AuditRow({ e }: { e: AuditEvent }) {
  const [open, setOpen] = useState(false);
  const time = e.ts.slice(11, 19); // HH:MM:SS from the rfc3339 timestamp
  return (
    <div role="listitem" className="text-compact">
      <WorkbenchItem
        presentationLevel="medium"
        title={e.detail}
        leading={<PresenceDot contentSize="small" className={AUDIT_META[e.kind].dot} />}
        trailing={<span className="font-code text-minimal tabular-nums">{time}</span>}
        onClick={e.extra ? () => setOpen((o) => !o) : undefined}
      />
      {open && e.extra && (
        <pre className="ml-6 mt-1 mb-1 text-compact bg-zinc-950 rounded-sm p-2 overflow-auto whitespace-pre-wrap text-content-muted max-h-48">
          {e.extra}
        </pre>
      )}
    </div>
  );
}

/** The onboarding form body for adding a bot installation on this Mac. */
function OnboardForm(props: {
  bots: BotItem[];
  existingBotId: string;
  setExistingBotId: (v: string) => void;
  agentType: AgentType;
  setAgentType: (v: AgentType) => void;
  onboarding: boolean;
  onboardingError: string | null;
  onSubmit: () => void;
  advancedOpen: boolean;
  setAdvancedOpen: (v: boolean) => void;
  newName: string;
  setNewName: (v: string) => void;
  newConfig: string;
  setNewConfig: (v: string) => void;
  busy: boolean;
  startFromToml: () => void;
}) {
  const p = props;
  return (
    <div className="grid gap-3">
      <div className="rounded-sm bg-indigo-950/35 p-3 text-compact text-accent-100">
        <p className="font-medium">Four steps, all on this Mac</p>
        <p className="mt-1 text-accent-200/75">
          Choose a bot → check its agent → save its secure installation → start and verify it.
          If startup fails, the installation remains below with recovery and diagnostics.
        </p>
      </div>
      <Field label="Bot identity" htmlFor="onb-bot">
          <UiSelect
            id="onb-bot"
            value={p.existingBotId}
            onChange={(e) => p.setExistingBotId(e.target.value)}
            controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-content-primary focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {p.bots.length === 0 && <option value="">No manageable bots</option>}
            {p.bots.map((b) => (
              <option key={b.bot_id} value={b.bot_id}>
                {b.display_name || b.username}
              </option>
            ))}
          </UiSelect>
        </Field>
      {p.bots.length === 0 && <div className="rounded-sm bg-amber-950/30 p-3 text-compact text-warning-200">
        Create a bot identity first; installations cannot create bots.
        <div className="mt-2"><Button action="open" variant="secondary" controlSize="compact" onClick={() => window.location.assign("/fleet/bots")}>Create bot in Fleet</Button></div>
      </div>}

      <Field label="Agent">
        <AgentPicker
          value={p.agentType}
          onPick={(key) => {
            // Picker keys are Cheers agent ids (claude/codex/opencode/registry-id)
            // or "custom" → generic placeholder config.
            p.setAgentType(key === "custom" ? "generic" : key);
          }}
        />
      </Field>

      <AgentUpdates />

      {p.onboardingError && (
        <div className="rounded-sm bg-rose-950/35 p-3 text-compact text-removed-200">
          <p className="font-medium">Setup needs attention</p>
          <p className="mt-1 break-words text-removed-200/80">{p.onboardingError}</p>
          <p className="mt-1 text-removed-200/70">
            You can fix the agent or configuration and retry. The saved installation remains on this page.
          </p>
        </div>
      )}

      <div>
        <Button action="setup" content="iconText"
          controlSize="compact"
          loading={p.onboarding}
          disabled={p.onboarding || !p.existingBotId}
          onClick={p.onSubmit}
        >
          <Play className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div>
        <UiButton action={p.advancedOpen ? "collapse" : "expand"} variant="plain"
          type="button"
          className=" text-content-primary hover:text-content-strong"
          onClick={() => p.setAdvancedOpen(!p.advancedOpen)}
        >
          {p.advancedOpen ? "▾" : "▸"} Advanced: start from an existing .toml
        </UiButton>
        {p.advancedOpen && (
          <div className="grid gap-3 mt-3">
            <Field label="Name" htmlFor="conn-name">
              <Input
                id="conn-name"
                value={p.newName}
                onChange={(e) => p.setNewName(e.target.value)}
                placeholder="default"
              />
            </Field>
            <Field label="Config path (.toml)" htmlFor="conn-config">
              <Input
                id="conn-config"
                value={p.newConfig}
                onChange={(e) => p.setNewConfig(e.target.value)}
                placeholder="/Users/you/.cheers/cheers-daemon.toml"
              />
            </Field>
            <div>
              <Button action="start" content="iconText"
                variant="secondary"
                controlSize="compact"
                disabled={!p.newName.trim() || !p.newConfig.trim() || p.busy}
                onClick={p.startFromToml}
              >
                <Play className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Nav gate: the section only exists inside the desktop shell. */
export function connectorSectionAvailable(): boolean {
  return isTauri();
}

// AgentPicker's DetectedAgent type is re-exported for callers that need it.
export type { DetectedAgent };
