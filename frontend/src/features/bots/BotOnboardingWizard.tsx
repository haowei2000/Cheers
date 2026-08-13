import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
import { useEffect, useState, type ReactNode } from "react";
import { notify, messageOf } from "@/lib/notify";
import { useNavigate } from "react-router-dom";
import { serverOrigin, isTauri } from "@/lib/serverConfig";
import { requestConnectorForBot } from "@/features/desktop/connectorIntent";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  Bot,
  Terminal,
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
  getBotStatus,
  getConnectorDiscovery,
  mintEnrollmentCode,
  revokeEnrollmentCodes,
  getEnrollmentGuidance,
  listAcpAgents,
  type AgentType,
  type AcpAgentInfo,
  type ConnectorDiscovery,
  type EnrollmentCode,
  type EnrollmentGuidance,
  type ConnectorConfig,
  type IssuedToken,
} from "@/api/bots";
import { Dialog } from "@/components/ui/dialog";
import { NavigationItem } from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import type { BotItem } from "@/types";

type Mode = "script" | "agent";

/** Where prebuilt connector binaries are published (release-connector workflow).
 * Keep in sync with the default in server/assets/install.sh. */
const CONNECTOR_RELEASES_REPO = "haowei2000/Cheers";
/** Pin GitHub fallbacks to a connector-v* tag — releases/latest is the desktop app. */
const CONNECTOR_RELEASE_TAG = "connector-v0.1.37";
/** Same-origin download (gateway proxies the GitHub release): works from hosts
 * that can reach this server but not GitHub. GitHub stays the fallback.
 * Native HTTP MCP is mandatory; only the connector binary is installed. */
// serverOrigin(), not window.location.origin: the snippet must name the
// GATEWAY the target host can reach — in the desktop shell the window origin
// is tauri://localhost, useless in a curl command.
const CONNECTOR_DOWNLOAD_CMD = `os=$(uname -s | tr 'A-Z' 'a-z'); arch=$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
mkdir -p ~/.cheers/bin
curl -fsSL -o ~/.cheers/bin/cce-acp-connector \\
  "${serverOrigin()}/api/v1/connector/download/cce-acp-connector-$os-$arch" \\
  || curl -fsSL -o ~/.cheers/bin/cce-acp-connector \\
  "https://github.com/${CONNECTOR_RELEASES_REPO}/releases/download/${CONNECTOR_RELEASE_TAG}/cce-acp-connector-$os-$arch"
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
    <UiButton action="copy" variant="plain"
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
      className="inline-flex items-center gap-1  text-zinc-100 hover:text-zinc-50 transition-colors"
    >
      {done ? (
        <Check className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
      {label ?? (done ? "Copied" : "Copy")}
    </UiButton>
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
    <div className="flex items-center gap-2 text-compact">
      {/* design-system-exempt: step-indicator — ordered wizard progress, not an entity list. */}
      {labels.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-compact font-semibold ${
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
    <p className="flex items-start gap-2 text-compact text-amber-400">
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-1" />
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
          <p className="text-compact text-red-400 break-words">{error}</p>
        )}

        {/* ── Step 0: choose / create bot ───────────────────────────── */}
        {step === 0 && (
          <div className="space-y-3">
            <div className="rounded-sm bg-indigo-950/35 px-3 py-3 text-compact text-indigo-100">
              <p className="font-medium">A bot is an identity; a connector is where it runs.</p>
              <p className="mt-1 text-indigo-200/75">
                {localDesktop
                  ? "This Mac can create the bot and run its connector in one guided setup."
                  : isMobile
                    ? "This phone creates the bot and a secure pairing code. Use that code on a Mac or Linux machine where your agent is installed."
                    : "This browser creates the bot and a secure pairing code. Run the connector later on the Mac or Linux machine where your agent is installed."}
              </p>
            </div>
            <div className="flex gap-2 text-compact">
              <UiButton action="create" variant="plain"
                type="button"
                onClick={() => setPick("create")}
                controlSize="regular" className={`rounded-sm ${
 pick === "create"? "bg-indigo-600 text-white"
 : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
 }`}
              >
                New bot
              </UiButton>
              <UiButton action="choose" variant="plain"
                type="button"
                disabled={!bots.length}
                onClick={() => setPick("existing")}
                controlSize="regular" className={`rounded-sm disabled:opacity-50 ${
 pick === "existing"? "bg-indigo-600 text-white"
 : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
 }`}
              >
                Existing bot
              </UiButton>
            </div>

            {pick === "create" ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-compact font-medium text-zinc-400 uppercase tracking-wide block mb-1">
                      Username
                    </label>
                    <UiInput
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="codex-main"
                      controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="text-compact font-medium text-zinc-400 uppercase tracking-wide block mb-1">
                      Display name
                    </label>
                    <UiInput
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Codex"
                      controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <label className="text-compact font-medium text-zinc-400 uppercase tracking-wide block mb-1">Bot</label>
                <UiSelect
                  value={existingId}
                  onChange={(e) => setExistingId(e.target.value)}
                  controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {bots.map((b) => (
                    <option key={b.bot_id} value={b.bot_id}>
                      {b.display_name || b.username} (@{b.username})
                    </option>
                  ))}
                </UiSelect>
              </div>
            )}

            <div>
              <label className="text-compact font-medium text-zinc-400 uppercase tracking-wide block mb-1">
                Agent type
              </label>
              <UiSelect
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
                controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {agentCatalog.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.source.startsWith("registry-") ? " (registry)" : ""}
                  </option>
                ))}
              </UiSelect>
            </div>

            <div className="flex justify-end items-center gap-2">
              {localDesktop && (
                <Button action="setup" content="iconText" variant="secondary" onClick={setupLocally} disabled={busy}>
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                  <Laptop className="w-4 h-4" /> Set up on this Mac
                </Button>
              )}
              <Button action="setup" onClick={validateAndAdvance} disabled={busy}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {localDesktop ? "Set up another host" : "Choose host"}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 1: pick a mode ───────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-3">
            <p className="text-compact text-zinc-400">
              Connecting{" "}
              <span className="text-zinc-200">
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
            </div>
            <div className="flex justify-start">
              <UiButton action="back" content="iconText" variant="plain"
                type="button"
                onClick={() => setStep(0)}
                className="inline-flex items-center gap-1  text-zinc-100 hover:text-zinc-50"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </UiButton>
            </div>
          </div>
        )}

        {/* ── Step 2: mode panel ────────────────────────────────────── */}
        {step === 2 && bot && (
          <div className="space-y-3">
            {mode === "script" && (
              <ScriptPanel bot={bot} agentType={agentType} discovery={discovery} />
            )}
            {mode === "agent" && (
              <AgentPanel bot={bot} agentType={agentType} discovery={discovery} />
            )}
            <ConnectionWatch botId={bot.bot_id} username={bot.username} />
            <div className="flex items-center justify-between">
              <UiButton action="back" content="iconText" variant="plain"
                type="button"
                onClick={() => {
                  setStep(1);
                  setMode(null);
                }}
                className="inline-flex items-center gap-1  text-zinc-100 hover:text-zinc-50"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Modes
              </UiButton>
              <Button action="done"
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
      <p className="flex items-center gap-2 rounded-sm bg-zinc-800/40 px-3 py-2 text-compact text-zinc-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Checking whether @{username} is connected…
      </p>
    );
  }
  return online ? (
    <p className="flex items-center gap-2 rounded-sm bg-emerald-950/40 px-3 py-2 text-compact text-emerald-300">
      <CheckCircle2 className="w-3.5 h-3.5" />
      @{username} is online — the connector reached the gateway. You're done.
    </p>
  ) : (
    <p className="flex items-center gap-2 rounded-sm bg-zinc-800/40 px-3 py-2 text-compact text-zinc-400">
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
    <NavigationItem
      onClick={onClick}
      disabled={disabled}
      controlSize="comfortable"
      presentationLevel="medium"
      className="border-b-0 bg-zinc-800/60 hover:bg-zinc-800"
      leading={<div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-sm bg-indigo-900/50">
        {icon}
      </div>}
      title={<span title={`${title} — ${desc}`}>{title} — {desc}</span>}
      status={badge ? <span className="rounded-sm bg-zinc-900 px-2 py-1 text-minimal text-zinc-400">{badge}</span> : undefined}
    />
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
  const tokenFile = config?.credential_file ?? `secrets/${accountId}.token`;
  return (
    <div className="space-y-3">
      <p className="text-compact text-zinc-400">
        Manual setup for <span className="text-zinc-200">@{bot.username}</span>{" "}
        ({agentType}). Two pieces: a settings file (safe to keep) and a token
        (a password — save it so only you can read it, and never commit it).
      </p>

      {/* 1. config */}
      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-compact font-semibold text-zinc-200">
            1. Connector config
          </span>
          <UiButton action="create" variant="plain"
            type="button"
            onClick={onGenConfig}
            disabled={busy}
            controlSize="regular" className="inline-flex items-center gap-2 rounded-sm bg-zinc-800  text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {config ? "Regenerate" : "Generate config"}
          </UiButton>
        </div>
        {config && (
          <>
            <ReachabilityNote reachability={config.reachability} />
            <div className="rounded-sm bg-zinc-950 p-3 max-h-48 overflow-y-auto">
              <pre className="text-compact leading-relaxed text-zinc-400 whitespace-pre-wrap break-all">
                {config.config_toml}
              </pre>
            </div>
            <div className="flex items-center gap-3">
              <CopyBtn value={config.config_toml} label="Copy config" />
              <UiButton action="download" content="iconText" variant="plain"
                type="button"
                onClick={() =>
                  download(
                    `cheers-daemon.${accountId}.toml`,
                    config.config_toml
                  )
                }
                className="inline-flex items-center gap-1  text-zinc-100 hover:text-zinc-50"
              >
                <Download className="w-3.5 h-3.5" /> Download
              </UiButton>
              <span className="text-compact text-zinc-400">
                save as <code className="text-zinc-400">{configFile}</code>
              </span>
            </div>
          </>
        )}
      </div>

      {/* 2. token */}
      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-compact font-semibold text-zinc-200">
            2. One-time token
          </span>
          <Button action="issue" content="iconText" controlSize="compact" onClick={onGenToken} disabled={busy}>
            <KeyRound className="w-3.5 h-3.5" />
            {token ? "Rotate token" : "Issue token"}
          </Button>
        </div>
        {token && (
          <>
            <p className="text-compact text-amber-400">
              {token.note ?? "Shown once. Rotating replaces any previous token."}
            </p>
            <div className="rounded-sm bg-zinc-950 p-3">
              <code className="text-compact text-emerald-300 break-all">
                {token.token}
              </code>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-compact text-zinc-400">
                write to <code className="text-zinc-400">~/.cheers/{tokenFile}</code> (chmod 600)
              </span>
              <CopyBtn value={token.token} label="Copy token" />
            </div>
          </>
        )}
      </div>

      {/* 3. run */}
      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <span className="text-compact font-semibold text-zinc-200">3. Start it</span>
        <div className="rounded-sm bg-zinc-950 p-3">
          <pre className="text-compact leading-relaxed text-zinc-400 whitespace-pre-wrap break-all">
{`mkdir -p ~/.cheers/workspace ~/.cheers/secrets
# (save the config + token from above into the paths shown)
cce-acp-connector start --config ${configFile} --name ${accountId}
cce-acp-connector status --name ${accountId}`}
          </pre>
        </div>
        <div className="space-y-2 pt-1">
          <p className="text-compact text-zinc-400">
            Need the connector binary? Cheers requires an Agent adapter with native HTTP MCP OAuth
            support. Unsupported adapters fail closed; no stdio sidecar is installed.
          </p>
          <div className="rounded-sm bg-zinc-950 p-3">
            <pre className="text-compact leading-relaxed text-zinc-400 whitespace-pre-wrap break-all">
              {CONNECTOR_DOWNLOAD_CMD}
            </pre>
          </div>
          <div className="flex items-center justify-between">
            <a
              href={`https://github.com/${CONNECTOR_RELEASES_REPO}/releases/tag/${CONNECTOR_RELEASE_TAG}`}
              target="_blank"
              rel="noreferrer"
              className="text-compact text-indigo-300 hover:text-indigo-200 underline underline-offset-2"
            >
              All platforms &amp; versions on GitHub Releases
            </a>
            <CopyBtn value={CONNECTOR_DOWNLOAD_CMD} label="Copy command" />
          </div>
          <p className="text-compact text-zinc-400">
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
  const needsApiKeyHint =
    agentType === "claude" ||
    agentType === "claude-acp" ||
    agentType === "codex" ||
    agentType === "codex-acp";
  const apiKeyVar =
    agentType === "codex" || agentType === "codex-acp"
      ? "OPENAI_API_KEY"
      : "ANTHROPIC_API_KEY";
  const commandWithKey = code
    ? `${apiKeyVar}='…' CHEERS_ENROLL_CODE='${code.code}' bash <(curl -fsSL ${installUrl})`
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
      <p className="text-compact text-zinc-400">
        One command on the agent's machine for{" "}
        <span className="text-zinc-200">@{bot.username}</span> ({agentType}). It
        trades the code below for a token, saves both files, and installs the
        connector so it restarts on its own after a reboot.
      </p>

      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-compact font-semibold text-zinc-200">
            1. Mint a one-time code
          </span>
          <div className="flex items-center gap-2">
            {code && (
              <UiButton action="revoke" content="iconText" variant="plain"
                type="button"
                onClick={revoke}
                disabled={busy}
                controlSize="regular" className="inline-flex items-center gap-1 rounded-sm bg-zinc-800  text-zinc-100 hover:bg-zinc-700 hover:text-zinc-50 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Revoke
              </UiButton>
            )}
            <Button action="create" controlSize="compact" onClick={mint} disabled={busy}>
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
          <p className="text-compact text-amber-400">
            Single-use, expires in ~{Math.round(code.ttl_secs / 60)} min.{" "}
            {code.live_codes} live code{code.live_codes === 1 ? "" : "s"} for this bot.
          </p>
        )}
      </div>

      {code && (
        <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
          <span className="text-compact font-semibold text-zinc-200">
            2. Run on the agent's machine
          </span>
          <div className="rounded-sm bg-zinc-950 p-3">
            <pre className="text-compact leading-relaxed text-emerald-300 whitespace-pre-wrap break-all">
              {command}
            </pre>
          </div>
          {needsApiKeyHint && (
            <div className="rounded-sm bg-amber-500/5 px-3 py-2 space-y-2">
              <p className="text-compact leading-relaxed text-amber-200/90">
                Headless API-key auth: export{" "}
                <code className="text-amber-100">{apiKeyVar}</code> in the{" "}
                <span className="text-amber-100">same</span> command so
                install.sh wires it into systemd/launchd. A key only in your
                shell profile will not reach the connector — and Cheers will not
                show a login URL for EnvVar methods.
              </p>
              <pre className="text-compact leading-relaxed text-emerald-300/90 whitespace-pre-wrap break-all">
                {commandWithKey}
              </pre>
              <div className="flex justify-end">
                <CopyBtn value={commandWithKey} label="Copy with API key" />
              </div>
            </div>
          )}
          <p className="text-compact text-zinc-400">
            No terminal handy? If that machine has the Cheers desktop app, open{" "}
            <span className="text-zinc-200">Settings → Connector → I have a code</span>{" "}
            and paste the code there instead.
          </p>
          <div className="flex items-center justify-between">
            <span className="text-compact text-zinc-400">
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
      <p className="text-compact text-zinc-400">
        Hand your own agent a prompt and it runs the installer for you. Honest
        framing: this is the install script (mode 2), driven by your agent — so
        it must leave a background service running, or{" "}
        <span className="text-zinc-200">@{bot.username}</span> goes offline when
        the agent's turn ends.
      </p>
      {guidanceError && (
        <p className="text-compact text-red-400 break-words">
          Failed to load the agent prompt template: {guidanceError}
        </p>
      )}

      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-compact font-semibold text-zinc-200">
            1. Mint a one-time code
          </span>
          <div className="flex items-center gap-2">
            {code && (
              <UiButton action="revoke" content="iconText" variant="plain"
                type="button"
                onClick={revoke}
                disabled={busy}
                controlSize="regular" className="inline-flex items-center gap-1 rounded-sm bg-zinc-800  text-zinc-100 hover:bg-zinc-700 hover:text-zinc-50 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Revoke
              </UiButton>
            )}
            <Button action="create" controlSize="compact" onClick={mint} disabled={busy}>
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
          <p className="text-compact text-amber-400">
            Single-use, expires in ~{Math.round(code.ttl_secs / 60)} min.
          </p>
        )}
      </div>

      {code && guidance && (
        <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
          <span className="text-compact font-semibold text-zinc-200">
            2. Paste this to your agent
          </span>
          <div className="rounded-sm bg-zinc-950 p-3 max-h-56 overflow-y-auto">
            <pre className="text-compact leading-relaxed text-zinc-200 whitespace-pre-wrap break-words">
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
