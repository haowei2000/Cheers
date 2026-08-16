import { Button as UiButton } from "@/components/ui/button";
import { Select as UiSelect } from "@/components/ui/select";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { notify, messageOf } from "@/lib/notify";
import { useNavigate } from "react-router-dom";
import { serverOrigin, isTauri } from "@/lib/serverConfig";
import { requestConnectorForBot } from "@/features/desktop/connectorIntent";
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
} from "@/api/bots";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { NavigationItem } from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import type { BotItem } from "@/types";

type Mode = "script" | "agent";

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

/** Whole seconds until `iso`, floored at 0. An absent or unparseable timestamp
 *  reads as expired, which fails toward "mint a fresh code" rather than toward
 *  a command that dies on the far machine. */
export function secondsUntil(iso: string | undefined, now: number = Date.now()): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** m:ss — a pairing code's whole life is minutes, so there is no hour part. */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

/** Ticks once a second while a code is live. The code is the only part of this
 *  flow with a deadline, and it runs out while the user is walking to the other
 *  machine — so the wizard shows the clock rather than a static "~15 min".
 *
 *  The remaining time is computed during render, not kept in state: a state copy
 *  synced by an effect is one frame stale, and that frame lands exactly when a
 *  fresh code arrives — flashing "expired" over a code seconds old. The tick
 *  state exists only to schedule the re-render, and stops once time is up. */
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

function Stepper({ step, labels }: { step: 0 | 1 | 2; labels: string[] }) {
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
  const botFieldId = useId();
  const agentFieldId = useId();

  // Step 0 — choose an existing bot and this installation's agent.
  const [agentType, setAgentType] = useState<AgentType>("codex");
  const [agentCatalog, setAgentCatalog] = useState<AcpAgentInfo[]>(FALLBACK_AGENTS);
  const [existingId, setExistingId] = useState(initialBotId ?? bots[0]?.bot_id ?? "");
  const [bot, setBot] = useState<BotItem | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [discovery, setDiscovery] = useState<ConnectorDiscovery | null>(null);

  // One pairing code for the whole wizard. Both modes redeem the SAME code —
  // "ask an agent" is the install-script one-liner wrapped in a prompt — so
  // owning it here means switching modes re-presents one code instead of
  // minting a second and leaving the first live against the per-bot cap.
  const [pairing, setPairing] = useState<InstallationPairing | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const mintingRef = useRef(false);
  /** bot+agent the auto-mint already ran for, so re-renders (and StrictMode's
   *  double-invoke) don't mint again and an explicit Revoke stays revoked. */
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

  /** Best-effort revoke of a code the wizard is about to stop showing. The code
   *  also expires on its own, so a failure here must not block the replacement
   *  the user asked for — hence no toast. */
  const discardPairing = useCallback(async (current: InstallationPairing | null) => {
    if (!current) return;
    try {
      await revokeTerminalInstallation(current.bot_id, current.installation_id);
    } catch {
      /* already revoked, redeemed, or expiring on its own */
    }
  }, []);

  /** Create a pending installation and hold its one-time code. Replaces (and
   *  revokes) any code this wizard already minted. */
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
      // Revoke first: the gateway caps live codes per bot, so replacing has to
      // free the old slot before asking for the next one.
      await discardPairing(previous);
      setPairing(await createInstallation(target.bot_id, agentType));
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      mintingRef.current = false;
      setPairingBusy(false);
    }
  }, [agentType, bots, discardPairing, existingId, pairing]);

  // Arriving at "Connect" always needs a code; the old per-mode "Create
  // installation" button only stood between the user and the command they came
  // for. Mint on arrival — the button below stays, for replacing an expired one.
  useEffect(() => {
    if (step !== 2 || !bot) return;
    const key = `${bot.bot_id}:${agentType}`;
    if (autoMintedFor.current === key) return;
    autoMintedFor.current = key;
    void mint();
  }, [step, bot, agentType, mint]);

  /** Drop the current code without minting a replacement. `autoMintedFor` keeps
   *  its key, so the arrival effect does not immediately re-mint what the user
   *  just deliberately revoked. */
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

  /** Changing either half of the identity invalidates a code already minted:
   *  the agent type is baked into the pending installation row, so a code minted
   *  for `codex` would install a codex adapter for a bot now marked `claude`. */
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
      <Stepper
        step={step}
        labels={initialBotId ? ["Agent", "Host", "Connect"] : ["Bot & agent", "Host", "Connect"]}
      />
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
            <Field
              label="Bot identity"
              htmlFor={initialBotId ? undefined : botFieldId}
              hint={!bots.length ? <span className="text-warning-300">Create a bot identity before adding an installation.</span> : undefined}
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
              hint="The ACP adapter this device will run. It is fixed when the pending installation is created."
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
            <PairingSection
              pairing={pairing}
              secondsLeft={secondsLeft}
              expired={expired}
              busy={pairingBusy}
              connected={connected}
              onMint={() => void mint()}
              onRevoke={() => void revokePairing()}
            />
            {mode === "script" && (
              <ScriptPanel
                bot={bot}
                agentType={agentType}
                discovery={discovery}
                pairing={pairing}
                expired={expired}
              />
            )}
            {mode === "agent" && (
              <AgentPanel
                bot={bot}
                discovery={discovery}
                pairing={pairing}
                expired={expired}
              />
            )}
            <ConnectionWatch
              botId={bot.bot_id}
              username={bot.username}
              onOnline={() => setConnected(true)}
            />
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
function ConnectionWatch({
  botId,
  username,
  onOnline,
}: {
  botId: string;
  username: string;
  /** Fired once, when the bridge first reports connected. */
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
        // Transient failure: keep the last known state rather than flapping to
        // "offline", which would read as the installation having dropped.
      }
      if (!alive) return;
      // The wizard asks one question — did this installation reach Cheers? — and
      // a yes settles it. Stop rather than poll for as long as the dialog stays
      // open; the bot list and Fleet own ongoing liveness.
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

/** The one-time code, its clock, and the controls to replace or drop it.
 *
 *  Shared by both modes on purpose: they hand the SAME code to the SAME
 *  installer, so a per-mode copy of this block meant switching modes silently
 *  minted a second code and left the first live against the per-bot cap. */
function PairingSection({
  pairing,
  secondsLeft,
  expired,
  busy,
  connected,
  onMint,
  onRevoke,
}: {
  pairing: InstallationPairing | null;
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
            <UiButton action="revoke" content="iconText" variant="secondary"
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
        <p className="text-compact text-content-muted">Creating a pending installation…</p>
      )}

      {pairing && connected && (
        <p className="text-compact text-content-muted">
          Redeemed. This code is spent — it can't be used a second time.
        </p>
      )}

      {pairing && !connected && !expired && (
        <p className="flex items-center gap-2 text-compact text-content-muted">
          <Clock className="w-3.5 h-3.5 flex-shrink-0" />
          <span>
            Single-use. Expires in{" "}
            <span className="tabular-nums text-warning-300">{formatCountdown(secondsLeft)}</span>
            {pairing.live_pairings
              ? ` · ${pairing.live_pairings} pending installation${pairing.live_pairings === 1 ? "" : "s"} for this bot`
              : ""}
          </span>
        </p>
      )}

      {pairing && !connected && expired && (
        <p className="flex items-start gap-2 text-compact text-warning-400">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-1" />
          <span>
            This code has expired — running it now fails with “pairing code is
            invalid or expired”. Press{" "}
            <span className="text-content-secondary">New code</span> and copy the
            command again.
          </span>
        </p>
      )}

      {!pairing && !busy && (
        <p className="text-compact text-content-muted">
          No live code. Press <span className="text-content-secondary">Create code</span> to
          register a pending installation for this bot.
        </p>
      )}
    </div>
  );
}

function ScriptPanel({
  bot,
  agentType,
  discovery,
  pairing,
  expired,
}: {
  bot: BotItem;
  agentType: AgentType;
  discovery: ConnectorDiscovery | null;
  pairing: InstallationPairing | null;
  expired: boolean;
}) {
  const installUrl = `${serverOrigin()}/api/v1/install.sh`;
  const command = pairing
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

  return (
    <div className="space-y-3">
      <p className="text-compact text-content-muted">
        One command on the agent's machine for{" "}
        <span className="text-content-secondary">@{bot.username}</span> ({agentType}). It
        trades the code above for an installation credential, saves both files, and installs the
        connector so it restarts on its own after a reboot.
      </p>

      {pairing && (
        <div className={`rounded-sm bg-zinc-800/40 p-3 space-y-2 ${expired ? "opacity-60" : ""}`}>
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
  discovery,
  pairing,
  expired,
}: {
  bot: BotItem;
  discovery: ConnectorDiscovery | null;
  pairing: InstallationPairing | null;
  expired: boolean;
}) {
  const [guidance, setGuidance] = useState<PairingGuidance | null>(null);
  // Persistent, not a toast: without the template, step 2 can never render, so
  // the failure must stay visible in the panel (StrictMode also double-runs this).
  const [guidanceError, setGuidanceError] = useState<string | null>(null);

  useEffect(() => {
    getPairingGuidance()
      .then(setGuidance)
      .catch((e) => setGuidanceError(messageOf(e)));
  }, []);

  const prompt =
    pairing && guidance
      ? guidance.prompt_template.replace(guidance.pairing_code_placeholder, pairing.pairing_code)
      : "";

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

      {pairing && guidance && (
        <div className={`rounded-sm bg-zinc-800/40 p-3 space-y-2 ${expired ? "opacity-60" : ""}`}>
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
