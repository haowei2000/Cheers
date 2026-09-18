import { Button as UiButton } from "@/components/ui/button";
import { Select as UiSelect } from "@/components/ui/select";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { notify, messageOf } from "@/lib/notify";
import { useNavigate } from "react-router-dom";
import { serverOrigin, isTauri } from "@/lib/serverConfig";
import { requestConnectorForBot } from "@/features/desktop/connectorIntent";
import { invokeDesktop } from "@/lib/desktop";
import {
  Terminal,
  Sparkles,
  Copy,
  Check,
  Clock,
  ArrowLeft,
  AlertTriangle,
  Laptop,
  Loader2,
  Ticket,
  Trash2,
  CheckCircle2,
  HelpCircle,
} from "lucide-react";
import {
  createHost,
  revokeConnectorHost,
  redeemHostPairing,
  getBotStatus,
  getConnectorDiscovery,
  getPairingGuidance,
  listAcpAgents,
  type AgentType,
  type AcpAgentInfo,
  type ConnectorDiscovery,
  type HostPairing,
  type PairingGuidance,
} from "@/api/bots";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import type { BotItem } from "@/types";

const FALLBACK_AGENTS: AcpAgentInfo[] = [
  { id: "claude", name: "Claude", source: "builtin", installable: true },
  { id: "codex", name: "Codex", source: "builtin", installable: true },
  { id: "opencode", name: "OpenCode", source: "builtin", installable: true },
  { id: "generic", name: "Something else", source: "builtin", installable: false },
];

function botLabel(bot: BotItem | undefined): string {
  if (!bot) return "—";
  return `${bot.display_name || bot.username} (@${bot.username})`;
}

function CopyBtn({
  value,
  title = "Copy",
  className,
}: {
  value: string;
  title?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  const label = done ? "Copied" : title;
  return (
    <UiButton
      action="copy"
      variant="plain"
      content="icon"
      controlSize="compact"
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      className={className}
    >
      {done ? (
        <Check className="w-3.5 h-3.5 text-success-400" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </UiButton>
  );
}

/** Whole seconds until `iso`, floored at 0. */
export function secondsUntil(iso: string | undefined, now: number = Date.now()): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** m:ss countdown format. */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function useSecondsLeft(expiresAt: string | undefined): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => {
      setTick((n) => n + 1);
      if (secondsUntil(expiresAt) <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return secondsUntil(expiresAt);
}

function Stepper({ step, labels }: { step: 0 | 1; labels: string[] }) {
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

function QuestionPopover({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);

  return (
    <div ref={rootRef} className="relative inline-flex items-center">
      <UiButton
        action="more"
        variant="plain"
        content="icon"
        controlSize="compact"
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={title ?? "Help and instructions"}
        title={title ?? "Help and instructions"}
        aria-expanded={open}
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </UiButton>
      {open && (
        <PopoverPanel
          placement="down"
          align="end"
          className="w-80 p-3 space-y-2 text-compact text-content-secondary shadow-lg z-50"
        >
          {children}
        </PopoverPanel>
      )}
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
        so a host running anywhere else may not be able to sign in. Setting
        up on this same machine will still work. Whoever runs the server can fix
        this by configuring its public address.
      </span>
    </p>
  );
}

export function CreateHostWizard({
  bots = [],
  initialBotId,
  initialStep = 0,
  initialPairing = null,
  initialGuidance = null,
  onClose = () => undefined,
  onDone,
}: {
  bots?: BotItem[];
  /** When opened from a bot detail, reuse that identity and add a device host. */
  initialBotId?: string;
  initialStep?: 0 | 1;
  initialPairing?: HostPairing | null;
  initialGuidance?: PairingGuidance | null;
  onClose?: () => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const localDesktop = isTauri();
  const [step, setStep] = useState<0 | 1>(initialStep);
  const botFieldId = useId();
  const agentFieldId = useId();

  // Step 0 — choose an existing bot and this host's agent.
  const [agentType, setAgentType] = useState<AgentType>("codex");
  const [agentCatalog, setAgentCatalog] = useState<AcpAgentInfo[]>(FALLBACK_AGENTS);
  const [existingId, setExistingId] = useState(initialBotId ?? bots[0]?.bot_id ?? "");
  const [bot, setBot] = useState<BotItem | null>(() => {
    if (initialBotId) {
      return bots.find((b) => b.bot_id === initialBotId) ?? bots[0] ?? null;
    }
    return bots[0] ?? null;
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localExecuting, setLocalExecuting] = useState(false);

  const [discovery, setDiscovery] = useState<ConnectorDiscovery | null>(null);
  const [guidance, setGuidance] = useState<PairingGuidance | null>(initialGuidance);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);

  const [pairing, setPairing] = useState<HostPairing | null>(initialPairing);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const mintingRef = useRef(false);
  const autoMintedFor = useRef<string | null>(null);
  const secondsLeft = useSecondsLeft(pairing?.expires_at);
  const expired = Boolean(pairing) && secondsLeft <= 0;

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

  useEffect(() => {
    getPairingGuidance()
      .then(setGuidance)
      .catch((e) => setGuidanceError(messageOf(e)));
  }, []);

  const discardPairing = useCallback(async (current: HostPairing | null) => {
    if (!current) return;
    try {
      await revokeConnectorHost(current.bot_id, current.host_id);
    } catch {
      /* already revoked, redeemed, or expiring on its own */
    }
  }, []);

  const mint = useCallback(async () => {
    if (mintingRef.current) return;
    const target = bots.find((b) => b.bot_id === existingId) ?? null;
    if (!target) {
      setError("Pick a bot.");
      return;
    }
    mintingRef.current = true;
    setPairingBusy(true);
    const previous = pairing;
    setPairing(null);
    try {
      await discardPairing(previous);
      setPairing(await createHost(target.bot_id, agentType));
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      mintingRef.current = false;
      setPairingBusy(false);
    }
  }, [agentType, bots, discardPairing, existingId, pairing]);

  // Automatically mint a pairing code when transitioning to Step 1
  useEffect(() => {
    if (step !== 1 || !bot) return;
    const key = `${bot.bot_id}:${agentType}`;
    if (autoMintedFor.current === key) return;
    autoMintedFor.current = key;
    void mint();
  }, [step, bot, agentType, mint]);

  async function revokePairing() {
    const previous = pairing;
    setPairing(null);
    setPairingBusy(true);
    try {
      await discardPairing(previous);
    } finally {
      setPairingBusy(false);
    }
  }

  function repick(next: { botId?: string; agent?: AgentType }) {
    const previous = pairing;
    setPairing(null);
    autoMintedFor.current = null;
    setConnected(false);
    if (next.botId !== undefined) setExistingId(next.botId);
    if (next.agent !== undefined) setAgentType(next.agent);
    void discardPairing(previous);
  }

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

  async function setupLocally() {
    setError(null);
    setBusy(true);
    try {
      const resolved = resolveBot();
      if (!resolved) return;
      requestConnectorForBot(resolved.bot_id, agentType);
      onClose();
      navigate("/fleet/hosts?local=1");
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRunLocally() {
    if (!pairing) return;
    setError(null);
    setLocalExecuting(true);
    try {
      const redeemed = await redeemHostPairing(pairing.pairing_code, "Cheers Desktop");
      const configPath = await invokeDesktop<string>("connector_write_onboarded", {
        accountId: redeemed.account_id,
        configToml: redeemed.config_toml,
        token: redeemed.credential,
        tokenFile: redeemed.credential_file,
      });
      await invokeDesktop("connector_start", { name: redeemed.account_id, configPath });
      notify.success(`Host "${redeemed.account_id}" is running locally`);
      setConnected(true);
    } catch (e) {
      notify.error(messageOf(e));
      await setupLocally();
    } finally {
      setLocalExecuting(false);
    }
  }

  const installUrl = `${serverOrigin()}/api/v1/install.sh`;
  const terminalCommand = pairing
    ? `CHEERS_PAIRING_CODE='${pairing.pairing_code}' bash <(curl -fsSL ${installUrl})`
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
  const commandWithKey = pairing
    ? `${apiKeyVar}='…' CHEERS_PAIRING_CODE='${pairing.pairing_code}' bash <(curl -fsSL ${installUrl})`
    : "";

  const agentPrompt =
    pairing && guidance
      ? guidance.prompt_template.replace(guidance.pairing_code_placeholder, pairing.pairing_code)
      : "";

  return (
    <Dialog
      title={
        <span className="flex items-center gap-2">
          <Laptop className="w-5 h-5 text-accent-400" /> Create a host
        </span>
      }
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <Stepper
        step={step}
        labels={initialBotId ? ["Agent", "Install & connect"] : ["Bot & agent", "Install & connect"]}
      />
      <div className="max-h-[70vh] overflow-y-auto pr-1 space-y-3">
        {error && (
          <p className="text-compact text-danger-400 break-words">{error}</p>
        )}

        {/* ── Step 0: choose an existing bot and host agent ─── */}
        {step === 0 && (
          <div className="space-y-3">
            <div className="rounded-sm bg-indigo-950/35 px-3 py-3 text-compact text-accent-100">
              <p className="font-medium">Create a runtime host for an existing bot.</p>
              <p className="mt-1 text-accent-200/75">
                The bot identity stays unchanged. This host chooses its own agent and device.
              </p>
            </div>
            <Field
              label="Bot identity"
              htmlFor={initialBotId ? undefined : botFieldId}
              hint={!bots.length ? <span className="text-warning-300">Create a bot identity before adding a host.</span> : undefined}
            >
              {initialBotId ? (
                <p className="rounded-sm bg-zinc-800/40 px-3 py-2 text-regular text-content-secondary">
                  {botLabel(bots.find((b) => b.bot_id === existingId))}
                </p>
              ) : (
                <UiSelect id={botFieldId} value={existingId} onChange={(e) => repick({ botId: e.target.value })} controlSize="regular">
                  {bots.map((b) => <option key={b.bot_id} value={b.bot_id}>{botLabel(b)}</option>)}
                </UiSelect>
              )}
            </Field>

            <Field
              label="Agent type"
              htmlFor={agentFieldId}
              hint="The ACP adapter this device will run. It is fixed when the pending host is created."
            >
              <UiSelect
                id={agentFieldId}
                value={agentType}
                onChange={(e) => repick({ agent: e.target.value })}
                controlSize="regular"
              >
                {agentCatalog.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.source.startsWith("registry-") ? " (registry)" : ""}
                  </option>
                ))}
              </UiSelect>
            </Field>

            <div className="flex justify-end items-center gap-2">
              {localDesktop && (
                <Button action="installHere" content="iconText" variant="secondary" onClick={setupLocally} loading={busy}>
                  <Laptop className="w-4 h-4" />
                </Button>
              )}
              <Button action="continue" onClick={validateAndAdvance} loading={busy} disabled={!bots.length} />
            </div>
          </div>
        )}

        {/* ── Step 1: unified card-based installation methods ──────── */}
        {step === 1 && bot && (
          <div className="space-y-3">
            <PairingSection
              pairing={pairing}
              secondsLeft={secondsLeft}
              expired={expired}
              busy={pairingBusy}
              connected={connected}
              onMint={() => void mint()}
              onRevoke={() => void revokePairing()}
            />

            {/* Method Card 1: Run in terminal */}
            <div className={`rounded-sm bg-zinc-800/40 p-3 space-y-2 ${expired ? "opacity-60" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Terminal className="w-4 h-4 text-accent-300 flex-shrink-0" />
                  <span className="text-compact font-semibold text-content-secondary truncate">
                    Run in terminal
                  </span>
                  <span className="rounded-sm bg-zinc-900 px-2 py-1 text-minimal text-content-muted flex-shrink-0">
                    Recommended · Easiest
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {localDesktop && (
                    <Button
                      action="installHere"
                      content="iconText"
                      variant="secondary"
                      controlSize="compact"
                      type="button"
                      onClick={() => void handleRunLocally()}
                      loading={localExecuting}
                      disabled={!pairing || expired || connected}
                      title="Directly activate and run connector on this Mac"
                    >
                      <Laptop className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {terminalCommand && (
                    <CopyBtn value={terminalCommand} title="Copy command" />
                  )}
                  <QuestionPopover title="Terminal setup instructions">
                    <p className="font-medium text-content-strong">Terminal installation</p>
                    <p>
                      Run this single command on the host to download the standalone connector,
                      pair it with @{bot.username}, and keep it running in the background as a system
                      service (launchd/systemd) that restarts on reboot.
                    </p>
                    {needsApiKeyHint && (
                      <div className="rounded-sm bg-amber-500/10 p-2 space-y-2">
                        <p className="text-minimal font-medium text-warning-200">
                          Headless API-key auth
                        </p>
                        <p className="text-minimal text-warning-300/90">
                          Export <code className="text-warning-100">{apiKeyVar}</code> in the same command
                          so install.sh wires it into systemd/launchd:
                        </p>
                        <div className="relative">
                          <pre className="text-minimal text-success-300/90 whitespace-pre-wrap break-all p-2 pr-9 bg-zinc-950 rounded-sm font-code">
                            {commandWithKey}
                          </pre>
                          <div className="absolute top-1.5 right-1.5">
                            <CopyBtn value={commandWithKey} title="Copy with API key" />
                          </div>
                        </div>
                      </div>
                    )}
                    <p className="text-minimal text-content-muted">
                      Tip: prepend a space so the code stays out of shell history
                      (<code className="text-content-muted">HISTCONTROL=ignorespace</code>).
                    </p>
                    {discovery && !discovery.configured && (
                      <ReachabilityNote reachability={discovery} />
                    )}
                  </QuestionPopover>
                </div>
              </div>

              <div className="rounded-sm bg-zinc-950 p-3">
                <pre className="text-compact leading-reading text-success-300 whitespace-pre-wrap break-all font-code select-all">
                  {terminalCommand || (pairingBusy ? "Creating pairing code…" : "No active code")}
                </pre>
              </div>
            </div>

            {/* Method Card 2: Ask an agent on the host */}
            <div className={`rounded-sm bg-zinc-800/40 p-3 space-y-2 ${expired ? "opacity-60" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Sparkles className="w-4 h-4 text-accent-300 flex-shrink-0" />
                  <span className="text-compact font-semibold text-content-secondary truncate">
                    Ask an agent on the host
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {agentPrompt && (
                    <CopyBtn value={agentPrompt} title="Copy prompt" />
                  )}
                  <QuestionPopover title="Agent prompt instructions">
                    <p className="font-medium text-content-strong">Ask an agent to set it up</p>
                    <p>
                      Copy and send this prompt to an AI agent (Claude Code, Cursor, OpenCode, etc.)
                      with terminal execution access on the host. The agent will run the guided installer
                      and configure persistent background execution.
                    </p>
                    {discovery && !discovery.configured && (
                      <ReachabilityNote reachability={discovery} />
                    )}
                  </QuestionPopover>
                </div>
              </div>

              <div className="rounded-sm bg-zinc-950 p-3 max-h-36 overflow-y-auto">
                <pre className="text-compact leading-reading text-content-secondary whitespace-pre-wrap break-words font-code select-all">
                  {agentPrompt || (guidanceError ? `Error: ${guidanceError}` : pairingBusy ? "Creating pairing code…" : "No active code")}
                </pre>
              </div>
            </div>

            <ConnectionWatch
              botId={bot.bot_id}
              username={bot.username}
              onOnline={() => setConnected(true)}
            />

            <div className="flex items-center justify-between pt-1">
              <UiButton
                action="back"
                content="iconText"
                variant="plain"
                type="button"
                onClick={() => setStep(0)}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </UiButton>
              <Button
                action="done"
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

function ConnectionWatch({
  botId,
  username,
  onOnline,
}: {
  botId: string;
  username: string;
  onOnline?: () => void;
}) {
  const [online, setOnline] = useState<boolean | null>(null);
  const onOnlineRef = useRef(onOnline);
  useEffect(() => {
    onOnlineRef.current = onOnline;
  }, [onOnline]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      let bridged = false;
      try {
        const s = await getBotStatus(botId);
        if (!alive) return;
        bridged = !!s.bridge_connected;
        setOnline(bridged);
      } catch {
        /* keep last known state */
      }
      if (!alive) return;
      if (bridged) {
        onOnlineRef.current?.();
        return;
      }
      timer = setTimeout(tick, 3000);
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
      @{username} is online — this host reached Cheers. You're done.
    </p>
  ) : (
    <p className="flex items-center gap-2 rounded-sm bg-zinc-800/40 px-3 py-2 text-compact text-content-muted">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      Waiting for @{username}'s host — finish setup on the device that
      runs the agent. This updates on its own.
    </p>
  );
}

function PairingSection({
  pairing,
  secondsLeft,
  expired,
  busy,
  connected,
  onMint,
  onRevoke,
}: {
  pairing: HostPairing | null;
  secondsLeft: number;
  expired: boolean;
  busy: boolean;
  connected: boolean;
  onMint: () => void;
  onRevoke: () => void;
}) {
  return (
    <div className="rounded-sm bg-zinc-800/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-compact font-semibold text-content-secondary">
          1. One-time pairing code
        </span>
        <div className="flex items-center gap-2">
          {pairing && !connected && (
            <UiButton
              action="revoke"
              content="iconText"
              variant="secondary"
              controlSize="compact"
              type="button"
              onClick={onRevoke}
              loading={busy}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </UiButton>
          )}
          <Button
            action={pairing ? "replace" : "create"}
            controlSize="compact"
            onClick={onMint}
            loading={busy}
          >
            {!busy && <Ticket className="w-3.5 h-3.5" />}
            {pairing ? "New code" : "Create code"}
          </Button>
        </div>
      </div>

      {busy && !pairing && (
        <p className="text-compact text-content-muted">Creating a pending host…</p>
      )}

      {pairing && connected && (
        <p className="text-compact text-content-muted">
          Redeemed. This code is spent — it can't be used a second time.
        </p>
      )}

      {pairing && !connected && !expired && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-1">
          <p className="flex items-center gap-2 text-compact text-content-muted flex-shrink-0">
            <Clock className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
              Single-use. Expires in{" "}
              <span className="tabular-nums text-warning-300">{formatCountdown(secondsLeft)}</span>
              {pairing.live_pairings
                ? ` · ${pairing.live_pairings} pending host${pairing.live_pairings === 1 ? "" : "s"} for this bot`
                : ""}
            </span>
          </p>
          <div className="flex items-center gap-2 min-w-0 max-w-full">
            <code className="text-compact font-code text-content-primary bg-zinc-950 px-2 py-1 rounded-sm select-all break-all sm:truncate">
              {pairing.pairing_code}
            </code>
            <CopyBtn value={pairing.pairing_code} title="Copy pairing code" />
          </div>
        </div>
      )}

      {pairing && !connected && expired && (
        <p className="flex items-start gap-2 text-compact text-warning-400">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-1" />
          <span>
            This code has expired — running it now fails with “pairing code is
            invalid or expired”. Press{" "}
            <span className="text-content-secondary">New code</span> to mint a fresh code.
          </span>
        </p>
      )}

      {!pairing && !busy && (
        <p className="text-compact text-content-muted">
          No live code. Press <span className="text-content-secondary">Create code</span> to
          register a pending host for this bot.
        </p>
      )}
    </div>
  );
}
