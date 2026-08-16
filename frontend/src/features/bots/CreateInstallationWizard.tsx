import { Button as UiButton } from "@/components/ui/button";
import { Select as UiSelect } from "@/components/ui/select";
import { useEffect, useState, type ReactNode } from "react";
import { notify, messageOf } from "@/lib/notify";
import { useNavigate } from "react-router-dom";
import { serverOrigin, isTauri } from "@/lib/serverConfig";
import { requestConnectorForBot } from "@/features/desktop/connectorIntent";
import {
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
  createInstallation,
  revokeTerminalInstallation,
  getBotStatus,
  getConnectorDiscovery,
  getPairingGuidance,
  listAcpAgents,
  type AgentType,
  type AcpAgentInfo,
  type ConnectorDiscovery,
  type InstallationPairing,
  type PairingGuidance,
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
      className="inline-flex items-center gap-1  text-content-primary hover:text-content-strong transition-colors"
    >
      {done ? (
        <Check className="w-3.5 h-3.5 text-success-400" />
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
                ? "bg-indigo-600 text-content-on-accent"
                : "bg-zinc-800 text-content-muted"
            }`}
          >
            {i + 1}
          </span>
          <span className={i <= step ? "text-content-secondary" : "text-content-muted"}>
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
    <p className="flex items-start gap-2 text-compact text-warning-400">
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-1" />
      <span>
        This server hasn't been given an address that other machines can reach,
        so an installation running anywhere else may not be able to sign in. Setting
        up on this same machine will still work. Whoever runs the server can fix
        this by configuring its public address.
      </span>
    </p>
  );
}

export function CreateInstallationWizard({
  bots,
  initialBotId,
  onClose,
  onDone,
}: {
  bots: BotItem[];
  /** When opened from a bot detail, reuse that identity and add a device installation. */
  initialBotId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const localDesktop = isTauri();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [mode, setMode] = useState<Mode | null>(null);

  // Step 0 — choose an existing bot and this installation's agent.
  const [agentType, setAgentType] = useState<AgentType>("codex");
  const [agentCatalog, setAgentCatalog] = useState<AcpAgentInfo[]>(FALLBACK_AGENTS);
  const [existingId, setExistingId] = useState(initialBotId ?? bots[0]?.bot_id ?? "");
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

  function resolveBot(): BotItem | null {
    const existing = bots.find((b) => b.bot_id === existingId) ?? null;
    if (!existing) setError("Pick a bot.");
    return existing;
  }

  function validateAndAdvance() {
    setError(null);
    const existing = resolveBot();
    if (!existing) return;
    setBot(existing);
    setStep(1);
  }

  /** Desktop only: resolve the bot, then jump straight to the local installation
   * setup with it pre-selected (skips the remote-device pairing modes). */
  async function setupLocally() {
    setError(null);
    setBusy(true);
    try {
      const resolved = resolveBot();
      if (!resolved) return;
      requestConnectorForBot(resolved.bot_id, agentType);
      onClose();
      navigate("/fleet/installations?local=1");
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  function pickMode(m: Mode) {
    setError(null);
    if (!bot) return;
    setMode(m);
    setStep(2);
  }

  return (
    <Dialog
      title={
        <span className="flex items-center gap-2">
          <Laptop className="w-5 h-5 text-accent-400" /> Create an installation
        </span>
      }
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <Stepper step={step} />
      <div className="max-h-[65vh] overflow-y-auto pr-1 space-y-3">
        {error && (
          <p className="text-compact text-danger-400 break-words">{error}</p>
        )}

        {/* ── Step 0: choose an existing bot and installation agent ─── */}
        {step === 0 && (
          <div className="space-y-3">
            <div className="rounded-sm bg-indigo-950/35 px-3 py-3 text-compact text-accent-100">
              <p className="font-medium">Create a runtime installation for an existing bot.</p>
              <p className="mt-1 text-accent-200/75">
                The bot identity stays unchanged. This installation chooses its own agent and device.
              </p>
            </div>
            <div>
              <label className="text-compact font-medium text-content-muted uppercase tracking-label block mb-1">Bot identity</label>
              <UiSelect value={existingId} disabled={Boolean(initialBotId)} onChange={(e) => setExistingId(e.target.value)} controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-content-primary focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {bots.map((b) => <option key={b.bot_id} value={b.bot_id}>{b.display_name || b.username} (@{b.username})</option>)}
              </UiSelect>
              {!bots.length && <p className="mt-2 text-compact text-warning-300">Create a bot identity before adding an installation.</p>}
            </div>

            <div>
              <label className="text-compact font-medium text-content-muted uppercase tracking-label block mb-1">
                Agent type
              </label>
              <UiSelect
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
                controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-content-primary focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
                <Button action="installHere" content="iconText" variant="secondary" onClick={setupLocally} loading={busy}>
                  <Laptop className="w-4 h-4" />
                </Button>
              )}
              <Button action="continue" onClick={validateAndAdvance} loading={busy} disabled={!bots.length}>
                {localDesktop ? "Install on another device" : "Choose device"}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 1: pick a mode ───────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-3">
            <p className="text-compact text-content-muted">
              Connecting{" "}
              <span className="text-content-secondary">
                @{bot?.username}
              </span>
              . Choose how the device that runs this bot will receive its secure pairing code.
            </p>
            <div className="grid gap-2">
              <ModeCard
                icon={<Terminal className="w-5 h-5 text-accent-300" />}
                title="Run one command on the host"
                badge="Easiest"
                desc="Recommended. One command pairs the bot and keeps its installation running in the background."
                onClick={() => pickMode("script")}
                disabled={busy}
              />
              <ModeCard
                icon={<Sparkles className="w-5 h-5 text-accent-300" />}
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
              >
                <ArrowLeft className="w-3.5 h-3.5" />
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
              <UiButton action="modes" content="iconText" variant="plain"
                type="button"
                onClick={() => {
                  setStep(1);
                  setMode(null);
                }}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
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
        // "offline", which would read as the installation having dropped.
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
      <p className="flex items-center gap-2 rounded-sm bg-zinc-800/40 px-3 py-2 text-compact text-content-muted">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Checking whether @{username} is connected…
      </p>
    );
  }
  return online ? (
    <p className="flex items-center gap-2 rounded-sm bg-emerald-950/40 px-3 py-2 text-compact text-success-300">
      <CheckCircle2 className="w-3.5 h-3.5" />
      @{username} is online — this installation reached Cheers. You're done.
    </p>
  ) : (
    <p className="flex items-center gap-2 rounded-sm bg-zinc-800/40 px-3 py-2 text-compact text-content-muted">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      Waiting for @{username}'s installation — finish setup on the device that
      runs the agent. This updates on its own.
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
      status={badge ? <span className="rounded-sm bg-zinc-900 px-2 py-1 text-minimal text-content-muted">{badge}</span> : undefined}
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
      <p className="text-compact text-content-muted">
        Manual setup for <span className="text-content-secondary">@{bot.username}</span>{" "}
        ({agentType}). Two pieces: a settings file (safe to keep) and an installation credential
        (a password — save it so only you can read it, and never commit it).
      </p>

      {/* 1. config */}
      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-compact font-semibold text-content-secondary">
            1. Connector config
          </span>
          <UiButton
            action="generate"
            variant="secondary"
            type="button"
            onClick={onGenConfig}
            loading={busy}
          >
            {config ? "Regenerate" : "Generate config"}
          </UiButton>
        </div>
        {config && (
          <>
            <ReachabilityNote reachability={config.reachability} />
            <div className="rounded-sm bg-zinc-950 p-3 max-h-48 overflow-y-auto">
              <pre className="text-compact leading-reading text-content-muted whitespace-pre-wrap break-all">
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
              >
                <Download className="w-3.5 h-3.5" />
              </UiButton>
              <span className="text-compact text-content-muted">
                save as <code className="text-content-muted">{configFile}</code>
              </span>
            </div>
          </>
        )}
      </div>

      {/* 2. installation credential */}
      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-compact font-semibold text-content-secondary">
            2. Installation credential
          </span>
          <Button
            action={token ? "rotate" : "issue"}
            content="iconText"
            controlSize="compact"
            onClick={onGenToken}
            loading={busy}
          >
            <KeyRound className="w-3.5 h-3.5" />
          </Button>
        </div>
        {token && (
          <>
            <p className="text-compact text-warning-400">
              {token.note ?? "Shown once. Rotating replaces this installation's previous credential."}
            </p>
            <div className="rounded-sm bg-zinc-950 p-3">
              <code className="text-compact text-success-300 break-all">
                {token.token}
              </code>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-compact text-content-muted">
                write to <code className="text-content-muted">~/.cheers/{tokenFile}</code> (chmod 600)
              </span>
              <CopyBtn value={token.token} label="Copy credential" />
            </div>
          </>
        )}
      </div>

      {/* 3. run */}
      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <span className="text-compact font-semibold text-content-secondary">3. Start it</span>
        <div className="rounded-sm bg-zinc-950 p-3">
          <pre className="text-compact leading-reading text-content-muted whitespace-pre-wrap break-all">
{`mkdir -p ~/.cheers/workspace ~/.cheers/secrets
# (save the config + credential from above into the paths shown)
cce-acp-connector start --config ${configFile} --name ${accountId}
cce-acp-connector status --name ${accountId}`}
          </pre>
        </div>
        <div className="space-y-2 pt-1">
          <p className="text-compact text-content-muted">
            Need the connector binary? Cheers requires an Agent adapter with native HTTP MCP OAuth
            support. Unsupported adapters fail closed; no stdio sidecar is installed.
          </p>
          <div className="rounded-sm bg-zinc-950 p-3">
            <pre className="text-compact leading-reading text-content-muted whitespace-pre-wrap break-all">
              {CONNECTOR_DOWNLOAD_CMD}
            </pre>
          </div>
          <div className="flex items-center justify-between">
            <a
              href={`https://github.com/${CONNECTOR_RELEASES_REPO}/releases/tag/${CONNECTOR_RELEASE_TAG}`}
              target="_blank"
              rel="noreferrer"
              className="text-compact text-accent-300 hover:text-accent-200 underline underline-offset-2"
            >
              All platforms &amp; versions on GitHub Releases
            </a>
            <CopyBtn value={CONNECTOR_DOWNLOAD_CMD} label="Copy command" />
          </div>
          <p className="text-compact text-content-muted">
            Or build from source:{" "}
            <code className="text-content-muted">cargo build --release</code> in{" "}
            <code className="text-content-muted">packages/cheers-acp-connector-rs</code>.
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
  const [code, setCode] = useState<InstallationPairing | null>(null);
  const [busy, setBusy] = useState(false);

  const installUrl = `${serverOrigin()}/api/v1/install.sh`;
  const command = code
    ? `CHEERS_PAIRING_CODE='${code.pairing_code}' bash <(curl -fsSL ${installUrl})`
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
    ? `${apiKeyVar}='…' CHEERS_PAIRING_CODE='${code.pairing_code}' bash <(curl -fsSL ${installUrl})`
    : "";

  async function mint() {
    setBusy(true);
    try {
      if (code) await revokeTerminalInstallation(bot.bot_id, code.installation_id);
      setCode(await createInstallation(bot.bot_id, agentType));
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      if (code) await revokeTerminalInstallation(bot.bot_id, code.installation_id);
      setCode(null);
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-compact text-content-muted">
        One command on the agent's machine for{" "}
        <span className="text-content-secondary">@{bot.username}</span> ({agentType}). It
        trades the code below for an installation credential, saves both files, and installs the
        connector so it restarts on its own after a reboot.
      </p>

      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-compact font-semibold text-content-secondary">
            1. Create a pending installation
          </span>
          <div className="flex items-center gap-2">
            {code && (
              <UiButton action="revoke" content="iconText" variant="secondary"
                type="button"
                onClick={revoke}
                loading={busy}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </UiButton>
            )}
            <Button
              action={code ? "replace" : "create"}
              controlSize="compact"
              onClick={mint}
              loading={busy}
            >
              {!busy && <Ticket className="w-3.5 h-3.5" />}
              {code ? "Replace installation" : "Create installation"}
            </Button>
          </div>
        </div>
        {code && (
          <p className="text-compact text-warning-400">
            Single-use, expires in ~{Math.round(code.ttl_secs / 60)} min.{" "}
            {code.live_pairings} pending installation{code.live_pairings === 1 ? "" : "s"} for this bot.
          </p>
        )}
      </div>

      {code && (
        <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
          <span className="text-compact font-semibold text-content-secondary">
            2. Run on the agent's machine
          </span>
          <div className="rounded-sm bg-zinc-950 p-3">
            <pre className="text-compact leading-reading text-success-300 whitespace-pre-wrap break-all">
              {command}
            </pre>
          </div>
          {needsApiKeyHint && (
            <div className="rounded-sm bg-amber-500/5 px-3 py-2 space-y-2">
              <p className="text-compact leading-reading text-warning-200/90">
                Headless API-key auth: export{" "}
                <code className="text-warning-100">{apiKeyVar}</code> in the{" "}
                <span className="text-warning-100">same</span> command so
                install.sh wires it into systemd/launchd. A key only in your
                shell profile will not reach the connector — and Cheers will not
                show a login URL for EnvVar methods.
              </p>
              <pre className="text-compact leading-reading text-success-300/90 whitespace-pre-wrap break-all">
                {commandWithKey}
              </pre>
              <div className="flex justify-end">
                <CopyBtn value={commandWithKey} label="Copy with API key" />
              </div>
            </div>
          )}
          <p className="text-compact text-content-muted">
            No terminal handy? If that machine has the Cheers desktop app, open{" "}
            <span className="text-content-secondary">Settings → Installations → I have a code</span>{" "}
            and paste the code there instead.
          </p>
          <div className="flex items-center justify-between">
            <span className="text-compact text-content-muted">
              Tip: prepend a space so the code stays out of shell history
              (<code className="text-content-muted">HISTCONTROL=ignorespace</code>).
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
  const [code, setCode] = useState<InstallationPairing | null>(null);
  const [guidance, setGuidance] = useState<PairingGuidance | null>(null);
  // Persistent, not a toast: without the template, step 2 can never render, so
  // the failure must stay visible in the panel (StrictMode also double-runs this).
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPairingGuidance()
      .then(setGuidance)
      .catch((e) => setGuidanceError(String(e)));
  }, []);

  const prompt =
    code && guidance
      ? guidance.prompt_template.replace(guidance.pairing_code_placeholder, code.pairing_code)
      : "";

  async function mint() {
    setBusy(true);
    try {
      if (code) await revokeTerminalInstallation(bot.bot_id, code.installation_id);
      setCode(await createInstallation(bot.bot_id, agentType));
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      if (code) await revokeTerminalInstallation(bot.bot_id, code.installation_id);
      setCode(null);
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-compact text-content-muted">
        Hand your own agent a prompt and it runs the installer for you. Honest
        framing: this is the install script (mode 2), driven by your agent — so
        it must leave a background service running, or{" "}
        <span className="text-content-secondary">@{bot.username}</span> goes offline when
        the agent's turn ends.
      </p>
      {guidanceError && (
        <p className="text-compact text-danger-400 break-words">
          Failed to load the agent prompt template: {guidanceError}
        </p>
      )}

      <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-compact font-semibold text-content-secondary">
            1. Create a pending installation
          </span>
          <div className="flex items-center gap-2">
            {code && (
              <UiButton action="revoke" content="iconText" variant="secondary"
                type="button"
                onClick={revoke}
                loading={busy}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </UiButton>
            )}
            <Button
              action={code ? "replace" : "create"}
              controlSize="compact"
              onClick={mint}
              loading={busy}
            >
              {!busy && <Ticket className="w-3.5 h-3.5" />}
              {code ? "Replace installation" : "Create installation"}
            </Button>
          </div>
        </div>
        {code && (
          <p className="text-compact text-warning-400">
            Single-use, expires in ~{Math.round(code.ttl_secs / 60)} min.
          </p>
        )}
      </div>

      {code && guidance && (
        <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
          <span className="text-compact font-semibold text-content-secondary">
            2. Paste this to your agent
          </span>
          <div className="rounded-sm bg-zinc-950 p-3 max-h-56 overflow-y-auto">
            <pre className="text-compact leading-reading text-content-secondary whitespace-pre-wrap break-words">
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
