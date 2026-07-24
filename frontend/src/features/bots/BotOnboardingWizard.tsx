import { useEffect, useState, type ReactNode } from "react";
import { notify, messageOf } from "@/lib/notify";
import { useNavigate } from "react-router-dom";
import { serverOrigin, isTauri } from "@/lib/serverConfig";
import { requestConnectorForBot } from "@/features/desktop/connectorIntent";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  Bot,
  Terminal,
  FileCode2,
  Sparkles,
  KeyRound,
  Copy,
  Check,
  Download,
  ArrowLeft,
  AlertTriangle,
  Laptop,
  Loader2,
  Ticket,
  Trash2,
  CheckCircle2,
} from "lucide-react";
import {
  createBot,
  issueBotToken,
  getBotStatus,
  getConnectorConfig,
  getConnectorDiscovery,
  mintEnrollmentCode,
  revokeEnrollmentCodes,
  getEnrollmentGuidance,
  listAcpAgents,
  type AgentType,
  type AcpAgentInfo,
  type ConnectorConfig,
  type ConnectorDiscovery,
  type EnrollmentCode,
  type EnrollmentGuidance,
  type IssuedToken,
} from "@/api/bots";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { BotItem } from "@/types";

type Mode = "manual" | "script" | "agent";

/** Where prebuilt connector binaries are published (release-connector workflow).
 * Keep in sync with the default in server/assets/install.sh. */
const CONNECTOR_RELEASES_REPO = "ElePerson/Cheers";
/** Same-origin download (gateway proxies the GitHub release): works from hosts
 * that can reach this server but not GitHub. GitHub stays the fallback. */
// serverOrigin(), not window.location.origin: the snippet must name the
// GATEWAY the target host can reach — in the desktop shell the window origin
// is tauri://localhost, useless in a curl command.
const CONNECTOR_DOWNLOAD_CMD = `os=$(uname -s | tr 'A-Z' 'a-z'); arch=$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
mkdir -p ~/.cheers/bin
curl -fsSL -o ~/.cheers/bin/cce-acp-connector \\
  "${serverOrigin()}/api/v1/connector/download/cce-acp-connector-$os-$arch" \\
  || curl -fsSL -o ~/.cheers/bin/cce-acp-connector \\
  "https://github.com/${CONNECTOR_RELEASES_REPO}/releases/latest/download/cce-acp-connector-$os-$arch"
chmod +x ~/.cheers/bin/cce-acp-connector
export PATH="$HOME/.cheers/bin:$PATH"`;

const FALLBACK_AGENTS: AcpAgentInfo[] = [
  { id: "claude", name: "Claude", source: "builtin", installable: true },
  { id: "codex", name: "Codex", source: "builtin", installable: true },
  { id: "opencode", name: "OpenCode", source: "builtin", installable: true },
  { id: "generic", name: "Something else", source: "builtin", installable: false },
];

function CopyBtn({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
    >
      {done ? (
        <Check className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
      {label ?? (done ? "Copied" : "Copy")}
    </button>
  );
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Stepper({ step }: { step: 0 | 1 | 2 }) {
  const labels = ["Choose bot", "Choose host", "Connect"];
  return (
    <div className="flex items-center gap-2 text-xs">
      {labels.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
              i <= step
                ? "bg-indigo-600 text-white"
                : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {i + 1}
          </span>
          <span className={i <= step ? "text-zinc-200" : "text-zinc-400"}>
            {label}
          </span>
          {i < labels.length - 1 && (
            <span className="mx-1 h-px w-6 bg-zinc-700" />
          )}
        </div>
      ))}
    </div>
  );
}

/** Warns that this server has no address a *different* machine could dial.
 *
 *  The operator's fix (a public base URL, or a port-forward for a local
 *  cluster) belongs in the server's own docs, not in a dialog aimed at whoever
 *  is setting up a bot — most people reading this can't change the server. Say
 *  what will go wrong and who can fix it; the deployment guide has the how. */
function ReachabilityNote({ reachability }: { reachability: { configured: boolean } }) {
  if (reachability.configured) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-400">
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
      <span>
        This server hasn't been given an address that other machines can reach,
        so a connector running anywhere else may not be able to sign in. Setting
        up on this same machine will still work. Whoever runs the server can fix
        this by configuring its public address.
      </span>
    </p>
  );
}

export function BotOnboardingWizard({
  bots,
  onClose,
  onDone,
}: {
  bots: BotItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const localDesktop = isTauri();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [mode, setMode] = useState<Mode | null>(null);

  // Step 0 — choose bot
  const [pick, setPick] = useState<"create" | "existing">(
    bots.length ? "existing" : "create"
  );
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("codex");
  const [agentCatalog, setAgentCatalog] = useState<AcpAgentInfo[]>(FALLBACK_AGENTS);
  const [existingId, setExistingId] = useState(bots[0]?.bot_id ?? "");
  const [bot, setBot] = useState<BotItem | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manual mode artifacts
  const [config, setConfig] = useState<ConnectorConfig | null>(null);
  const [token, setToken] = useState<IssuedToken | null>(null);
  const [discovery, setDiscovery] = useState<ConnectorDiscovery | null>(null);

  useEffect(() => {
    getConnectorDiscovery()
      .then(setDiscovery)
      .catch(() => {});
  }, []);

  useEffect(() => {
    listAcpAgents()
      .then((agents) => {
        if (agents.length) setAgentCatalog(agents);
      })
      .catch(() => {});
  }, []);

  // Picking an existing bot adopts the agent it was registered for, so the
  // config and enrollment code the panels mint below match its actual adapter.
  useEffect(() => {
    if (pick !== "existing") return;
    const provider = bots.find((b) => b.bot_id === existingId)?.bridge_provider;
    if (provider && agentCatalog.some((a) => a.id === provider)) {
      setAgentType(provider);
    }
  }, [pick, existingId, bots, agentCatalog]);

  /** The agent a bot is actually registered for. For a brand-new bot that's the
   * picker value; for an existing one it's whatever it was created with —
   * re-using the picker there would mint a config for the wrong adapter. */
  function agentTypeFor(b: BotItem): AgentType {
    if (pick === "create") return agentType;
    const provider = b.bridge_provider;
    return provider && agentCatalog.some((a) => a.id === provider)
      ? provider
      : agentType;
  }

  /** Resolve the chosen bot (create a new one, or use the selected existing
   * one). Shared by "Continue" and the desktop "Set up on this Mac" hand-off. */
  async function resolveBot(): Promise<BotItem | null> {
    if (pick === "create") {
      if (!username.trim()) {
        setError("Username is required.");
        return null;
      }
      const created = await createBot({
        username: username.trim(),
        display_name: displayName.trim() || undefined,
        bridge_provider: agentType,
      });
      onDone(); // refresh the parent list
      return created;
    }
    const existing = bots.find((b) => b.bot_id === existingId) ?? null;
    if (!existing) setError("Pick a bot.");
    return existing;
  }

  /** Step 0 → 1. Validates only: creating the bot here would leave an orphan
   * behind whenever someone opens the wizard, clicks Continue, and thinks
   * better of it — the wizard has no delete affordance to undo that. The bot is
   * created once a mode is picked (see `pickMode`), which is the first point
   * the user has committed to actually connecting something. */
  function validateAndAdvance() {
    setError(null);
    if (pick === "create" && !username.trim()) {
      setError("Username is required.");
      return;
    }
    if (pick === "existing") {
      const existing = bots.find((b) => b.bot_id === existingId) ?? null;
      if (!existing) {
        setError("Pick a bot.");
        return;
      }
      setBot(existing);
    }
    setStep(1);
  }

  /** Desktop only: resolve the bot, then jump straight to the local
   * "New connector" setup with it pre-selected (skips the remote-machine
   * connection modes — the connector runs right here). */
  async function setupLocally() {
    setError(null);
    setBusy(true);
    try {
      const resolved = await resolveBot();
      if (!resolved) return;
      requestConnectorForBot(resolved.bot_id, agentTypeFor(resolved));
      onClose();
      navigate("/settings/connector");
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function genConfig() {
    if (!bot) return;
    setBusy(true);
    try {
      setConfig(await getConnectorConfig(bot.bot_id, agentType));
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function genToken() {
    if (!bot) return;
    setBusy(true);
    try {
      setToken(await issueBotToken(bot.bot_id));
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  /** Step 1 → 2, and the point the bot actually gets created: the user has now
   * chosen how they intend to connect it. Creation failures (duplicate
   * username, quota) keep them on the mode list with a persistent error rather
   * than dropping them into a panel with no bot behind it. */
  async function pickMode(m: Mode) {
    setError(null);
    setBusy(true);
    try {
      const resolved = bot ?? (await resolveBot());
      if (!resolved) return;
      setBot(resolved);
      setMode(m);
      setStep(2);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={
        <span className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-indigo-400" /> Connect an agent
        </span>
      }
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <Stepper step={step} />
      <div className="max-h-[65vh] overflow-y-auto pr-1 space-y-3">
        {error && (
          <p className="text-xs text-red-400 break-words">{error}</p>
        )}

        {/* ── Step 0: choose / create bot ───────────────────────────── */}
        {step === 0 && (
          <div className="space-y-3">
            <div className="rounded-xl bg-indigo-950/35 px-3 py-2.5 text-xs text-indigo-100">
              <p className="font-medium">A bot is an identity; a connector is where it runs.</p>
              <p className="mt-1 text-indigo-200/75">
                {localDesktop
                  ? "This Mac can create the bot and run its connector in one guided setup."
                  : isMobile
                    ? "This phone creates the bot and a secure pairing code. Use that code on a Mac or Linux machine where your agent is installed."
                    : "This browser creates the bot and a secure pairing code. Run the connector later on the Mac or Linux machine where your agent is installed."}
              </p>
            </div>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setPick("create")}
                className={`rounded-lg px-3 py-1.5 ${
                  pick === "create"
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
              >
                New bot
              </button>
              <button
                type="button"
                disabled={!bots.length}
                onClick={() => setPick("existing")}
                className={`rounded-lg px-3 py-1.5 disabled:opacity-40 ${
                  pick === "existing"
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
              >
                Existing bot
              </button>
            </div>

            {pick === "create" ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide block mb-1">
                      Username
                    </label>
                    <input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="codex-main"
                      className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide block mb-1">
                      Display name
                    </label>
                    <input
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Codex"
                      className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide block mb-1">Bot</label>
                <select
                  value={existingId}
                  onChange={(e) => setExistingId(e.target.value)}
                  className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {bots.map((b) => (
                    <option key={b.bot_id} value={b.bot_id}>
                      {b.display_name || b.username} (@{b.username})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide block mb-1">
                Agent type
              </label>
              <select
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {agentCatalog.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.source.startsWith("registry-") ? " (registry)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-end items-center gap-2">
              {localDesktop && (
                <Button variant="secondary" onClick={setupLocally} disabled={busy}>
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                  <Laptop className="w-4 h-4" /> Set up on this Mac
                </Button>
              )}
              <Button onClick={validateAndAdvance} disabled={busy}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {localDesktop ? "Set up another host" : "Choose host"}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 1: pick a mode ───────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              Connecting{" "}
              <span className="text-zinc-300">
                @{bot?.username ?? username.trim()}
              </span>
              . Choose how the host machine will receive its secure pairing code.
            </p>
            <div className="grid gap-2">
              <ModeCard
                icon={<Terminal className="w-5 h-5 text-indigo-300" />}
                title="Run one command on the host"
                badge="Easiest"
                desc="Recommended. On the Mac or Linux host, one command pairs the bot, writes its config, and starts a background connector."
                onClick={() => pickMode("script")}
                disabled={busy}
              />
              <ModeCard
                icon={<Sparkles className="w-5 h-5 text-indigo-300" />}
                title="Ask an agent on the host to set it up"
                desc="Copy a prompt to an agent that has terminal access on the host. It follows the same guided installer."
                onClick={() => pickMode("agent")}
                disabled={busy}
              />
              <ModeCard
                icon={<FileCode2 className="w-5 h-5 text-indigo-300" />}
                title="Configure the host manually"
                desc="For operators who need to inspect every setting and start the connector themselves."
                onClick={() => pickMode("manual")}
                disabled={busy}
              />
            </div>
            <div className="flex justify-start">
              <button
                type="button"
                onClick={() => setStep(0)}
                className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: mode panel ────────────────────────────────────── */}
        {step === 2 && bot && (
          <div className="space-y-3">
            {mode === "manual" && (
              <ManualPanel
                bot={bot}
                agentType={agentType}
                config={config}
                token={token}
                busy={busy}
                onGenConfig={genConfig}
                onGenToken={genToken}
              />
            )}
            {mode === "script" && (
              <ScriptPanel bot={bot} agentType={agentType} discovery={discovery} />
            )}
            {mode === "agent" && (
              <AgentPanel bot={bot} agentType={agentType} discovery={discovery} />
            )}
            <ConnectionWatch botId={bot.bot_id} username={bot.username} />
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setStep(1);
                  setMode(null);
                }}
                className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Modes
              </button>
              <Button
                onClick={() => {
                  onDone();
                  onClose();
                }}
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Live "did it actually work?" line for step 2.
 *
 *  The wizard used to end on a Done button that closed the dialog and nothing
 *  else — the stepper promised "Connect" while never observing a connection, so
 *  the only way to learn whether the setup took was to go back to the list and
 *  read a status dot. The gateway already knows: `bridge_connected` is live
 *  truth from the connection registry. Poll it, because the user's half of this
 *  happens on another machine and can succeed at any moment. */
function ConnectionWatch({ botId, username }: { botId: string; username: string }) {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const s = await getBotStatus(botId);
        if (!alive) return;
        setOnline(!!s.bridge_connected);
      } catch {
        // Transient failure: keep the last known state rather than flapping to
        // "offline", which would read as the connector having dropped.
      }
      if (alive) timer = setTimeout(tick, 3000);
    }
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [botId]);

  if (online === null) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-zinc-800/40 px-3 py-2 text-xs text-zinc-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Checking whether @{username} is connected…
      </p>
    );
  }
  return online ? (
    <p className="flex items-center gap-2 rounded-lg bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
      <CheckCircle2 className="w-3.5 h-3.5" />
      @{username} is online — the connector reached the gateway. You're done.
    </p>
  ) : (
    <p className="flex items-center gap-2 rounded-lg bg-zinc-800/40 px-3 py-2 text-xs text-zinc-400">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      Waiting for @{username} to connect — finish the steps above on the agent's
      machine. This updates on its own.
    </p>
  );
}

function ModeCard({
  icon,
  title,
  desc,
  badge,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  badge?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-start gap-3 rounded-xl bg-zinc-800/60 p-3 text-left hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:hover:bg-zinc-800/60"
    >
      <div className="w-9 h-9 rounded-lg bg-indigo-900/50 flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-100 flex items-center gap-2">
          {title}
          {badge && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {badge}
            </span>
          )}
        </p>
        <p className="text-xs text-zinc-400 mt-0.5">{desc}</p>
      </div>
    </button>
  );
}

function ManualPanel({
  bot,
  agentType,
  config,
  token,
  busy,
  onGenConfig,
  onGenToken,
}: {
  bot: BotItem;
  agentType: AgentType;
  config: ConnectorConfig | null;
  token: IssuedToken | null;
  busy: boolean;
  onGenConfig: () => void;
  onGenToken: () => void;
}) {
  const accountId = config?.account_id ?? bot.username;
  const configFile = `~/.cheers/cheers-daemon.${accountId}.toml`;
  const tokenFile = config?.token_file ?? `secrets/${accountId}.token`;
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">
        Manual setup for <span className="text-zinc-300">@{bot.username}</span>{" "}
        ({agentType}). Two pieces: a settings file (safe to keep) and a token
        (a password — save it so only you can read it, and never commit it).
      </p>

      {/* 1. config */}
      <div className="rounded-xl bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-300">
            1. Connector config
          </span>
          <button
            type="button"
            onClick={onGenConfig}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {config ? "Regenerate" : "Generate config"}
          </button>
        </div>
        {config && (
          <>
            <ReachabilityNote reachability={config.reachability} />
            <div className="rounded-lg bg-zinc-950 p-3 max-h-48 overflow-y-auto">
              <pre className="text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap break-all">
                {config.config_toml}
              </pre>
            </div>
            <div className="flex items-center gap-3">
              <CopyBtn value={config.config_toml} label="Copy config" />
              <button
                type="button"
                onClick={() =>
                  download(
                    `cheers-daemon.${accountId}.toml`,
                    config.config_toml
                  )
                }
                className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
              >
                <Download className="w-3.5 h-3.5" /> Download
              </button>
              <span className="text-xs text-zinc-400">
                save as <code className="text-zinc-400">{configFile}</code>
              </span>
            </div>
          </>
        )}
      </div>

      {/* 2. token */}
      <div className="rounded-xl bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-300">
            2. One-time token
          </span>
          <Button size="sm" onClick={onGenToken} disabled={busy}>
            <KeyRound className="w-3.5 h-3.5" />
            {token ? "Rotate token" : "Issue token"}
          </Button>
        </div>
        {token && (
          <>
            <p className="text-xs text-amber-400">
              {token.note ?? "Shown once. Rotating replaces any previous token."}
            </p>
            <div className="rounded-lg bg-zinc-950 p-3">
              <code className="text-xs text-emerald-300 break-all">
                {token.token}
              </code>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">
                write to <code className="text-zinc-400">~/.cheers/{tokenFile}</code> (chmod 600)
              </span>
              <CopyBtn value={token.token} label="Copy token" />
            </div>
          </>
        )}
      </div>

      {/* 3. run */}
      <div className="rounded-xl bg-zinc-800/40 p-3 space-y-2">
        <span className="text-xs font-semibold text-zinc-300">3. Start it</span>
        <div className="rounded-lg bg-zinc-950 p-3">
          <pre className="text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap break-all">
{`mkdir -p ~/.cheers/workspace ~/.cheers/secrets
# (save the config + token from above into the paths shown)
cce-acp-connector start --config ${configFile} --name ${accountId}
cce-acp-connector status --name ${accountId}`}
          </pre>
        </div>
        <div className="space-y-1.5 pt-1">
          <p className="text-xs text-zinc-400">
            Need the connector binary? Download the prebuilt release (no Rust toolchain needed):
          </p>
          <div className="rounded-lg bg-zinc-950 p-3">
            <pre className="text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap break-all">
              {CONNECTOR_DOWNLOAD_CMD}
            </pre>
          </div>
          <div className="flex items-center justify-between">
            <a
              href={`https://github.com/${CONNECTOR_RELEASES_REPO}/releases/latest`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-indigo-300 hover:text-indigo-200 underline underline-offset-2"
            >
              All platforms &amp; versions on GitHub Releases
            </a>
            <CopyBtn value={CONNECTOR_DOWNLOAD_CMD} label="Copy command" />
          </div>
          <p className="text-xs text-zinc-400">
            Or build from source:{" "}
            <code className="text-zinc-400">cargo build --release</code> in{" "}
            <code className="text-zinc-400">packages/cheers-acp-connector-rs</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

function ScriptPanel({
  bot,
  agentType,
  discovery,
}: {
  bot: BotItem;
  agentType: AgentType;
  discovery: ConnectorDiscovery | null;
}) {
  const [code, setCode] = useState<EnrollmentCode | null>(null);
  const [busy, setBusy] = useState(false);

  const installUrl = `${serverOrigin()}/api/v1/install.sh`;
  const command = code
    ? `CHEERS_ENROLL_CODE='${code.code}' bash <(curl -fsSL ${installUrl})`
    : "";

  async function mint() {
    setBusy(true);
    try {
      setCode(await mintEnrollmentCode(bot.bot_id, agentType));
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await revokeEnrollmentCodes(bot.bot_id);
      setCode(null);
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">
        One command on the agent's machine for{" "}
        <span className="text-zinc-300">@{bot.username}</span> ({agentType}). It
        trades the code below for a token, saves both files, and installs the
        connector so it restarts on its own after a reboot.
      </p>

      <div className="rounded-xl bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-300">
            1. Mint a one-time code
          </span>
          <div className="flex items-center gap-2">
            {code && (
              <button
                type="button"
                onClick={revoke}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" /> Revoke
              </button>
            )}
            <Button size="sm" onClick={mint} disabled={busy}>
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Ticket className="w-3.5 h-3.5" />
              )}
              {code ? "New code" : "Mint code"}
            </Button>
          </div>
        </div>
        {code && (
          <p className="text-xs text-amber-400">
            Single-use, expires in ~{Math.round(code.ttl_secs / 60)} min.{" "}
            {code.live_codes} live code{code.live_codes === 1 ? "" : "s"} for this bot.
          </p>
        )}
      </div>

      {code && (
        <div className="rounded-xl bg-zinc-800/40 p-3 space-y-2">
          <span className="text-xs font-semibold text-zinc-300">
            2. Run on the agent's machine
          </span>
          <div className="rounded-lg bg-zinc-950 p-3">
            <pre className="text-[11px] leading-relaxed text-emerald-300 whitespace-pre-wrap break-all">
              {command}
            </pre>
          </div>
          <p className="text-xs text-zinc-400">
            No terminal handy? If that machine has the Cheers desktop app, open{" "}
            <span className="text-zinc-300">Settings → Connector → I have a code</span>{" "}
            and paste the code there instead.
          </p>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">
              Tip: prepend a space so the code stays out of shell history
              (<code className="text-zinc-400">HISTCONTROL=ignorespace</code>).
            </span>
            <CopyBtn value={command} label="Copy command" />
          </div>
          {discovery && !discovery.configured && (
            <ReachabilityNote reachability={discovery} />
          )}
        </div>
      )}
    </div>
  );
}

function AgentPanel({
  bot,
  agentType,
  discovery,
}: {
  bot: BotItem;
  agentType: AgentType;
  discovery: ConnectorDiscovery | null;
}) {
  const [code, setCode] = useState<EnrollmentCode | null>(null);
  const [guidance, setGuidance] = useState<EnrollmentGuidance | null>(null);
  // Persistent, not a toast: without the template, step 2 can never render, so
  // the failure must stay visible in the panel (StrictMode also double-runs this).
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getEnrollmentGuidance()
      .then(setGuidance)
      .catch((e) => setGuidanceError(String(e)));
  }, []);

  const prompt =
    code && guidance
      ? guidance.prompt_template.replace(guidance.code_placeholder, code.code)
      : "";

  async function mint() {
    setBusy(true);
    try {
      setCode(await mintEnrollmentCode(bot.bot_id, agentType));
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await revokeEnrollmentCodes(bot.bot_id);
      setCode(null);
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">
        Hand your own agent a prompt and it runs the installer for you. Honest
        framing: this is the install script (mode 2), driven by your agent — so
        it must leave a background service running, or{" "}
        <span className="text-zinc-300">@{bot.username}</span> goes offline when
        the agent's turn ends.
      </p>
      {guidanceError && (
        <p className="text-xs text-red-400 break-words">
          Failed to load the agent prompt template: {guidanceError}
        </p>
      )}

      <div className="rounded-xl bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-300">
            1. Mint a one-time code
          </span>
          <div className="flex items-center gap-2">
            {code && (
              <button
                type="button"
                onClick={revoke}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" /> Revoke
              </button>
            )}
            <Button size="sm" onClick={mint} disabled={busy}>
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Ticket className="w-3.5 h-3.5" />
              )}
              {code ? "New code" : "Mint code"}
            </Button>
          </div>
        </div>
        {code && (
          <p className="text-xs text-amber-400">
            Single-use, expires in ~{Math.round(code.ttl_secs / 60)} min.
          </p>
        )}
      </div>

      {code && guidance && (
        <div className="rounded-xl bg-zinc-800/40 p-3 space-y-2">
          <span className="text-xs font-semibold text-zinc-300">
            2. Paste this to your agent
          </span>
          <div className="rounded-lg bg-zinc-950 p-3 max-h-56 overflow-y-auto">
            <pre className="text-[11px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-words">
              {prompt}
            </pre>
          </div>
          <div className="flex items-center justify-end">
            <CopyBtn value={prompt} label="Copy prompt" />
          </div>
          {discovery && !discovery.configured && (
            <ReachabilityNote reachability={discovery} />
          )}
        </div>
      )}
    </div>
  );
}
