import { useEffect, useMemo, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { Link } from "react-router-dom";
import { AppIcon } from "./components/icons/AppIcon";

type DiscoveryData = {
  base_url?: string;
  bridge?: {
    control_ws?: string;
    data_ws?: string;
  };
  entrypoints?: {
    discovery?: { url?: string };
    register?: { url?: string };
    help_get?: { url?: string };
  };
};

type DiscoveryResponse = {
  data?: DiscoveryData;
};

type Step = {
  id: string;
  title: string;
  summary: string;
};

type AgentPackage = {
  name: string;
  npmPackage: string;
  install: string;
  command: string;
  args: string[];
  note: string;
  packageUrl: string;
};

const setupSteps: Step[] = [
  {
    id: "packages",
    title: "1. Install a ready-made ACP agent",
    summary: "Pick the ACP runtime for your agent; do not write an adapter yourself.",
  },
  {
    id: "check",
    title: "2. Check the ACP runtime",
    summary: "Confirm the installed command exists and is already logged in.",
  },
  {
    id: "register",
    title: "3. Register an AgentNexus Bot",
    summary: "Create an Agent Bridge Bot with bridge_provider set to acp.",
  },
  {
    id: "config",
    title: "4. Save the connector config",
    summary: "Write a local TOML policy file and edit the ACP agent command.",
  },
  {
    id: "run",
    title: "5. Start the connector",
    summary: "Run in foreground for debugging, then switch to daemon mode.",
  },
  {
    id: "verify",
    title: "6. Verify from both sides",
    summary: "Check connector logs, Bot online state, and one real @ mention.",
  },
];

const commonAgentPackages: AgentPackage[] = [
  {
    name: "Codex CLI",
    npmPackage: "@zed-industries/codex-acp",
    install: "npm install -g @zed-industries/codex-acp",
    command: "codex-acp",
    args: [],
    note: "Use the packaged Codex ACP adapter directly.",
    packageUrl: "https://www.npmjs.com/package/@zed-industries/codex-acp",
  },
  {
    name: "Claude Agent",
    npmPackage: "@agentclientprotocol/claude-agent-acp",
    install: "npm install -g @agentclientprotocol/claude-agent-acp",
    command: "claude-agent-acp",
    args: [],
    note: "Use when the local runtime is Claude Agent over ACP.",
    packageUrl: "https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp",
  },
  {
    name: "OpenCode",
    npmPackage: "opencode-ai",
    install: "npm install -g opencode-ai",
    command: "opencode",
    args: ["acp"],
    note: "Good default for local coding-agent workspaces.",
    packageUrl: "https://www.npmjs.com/package/opencode-ai",
  },
  {
    name: "Gemini CLI",
    npmPackage: "@google/gemini-cli",
    install: "npm install -g @google/gemini-cli",
    command: "gemini",
    args: ["--acp"],
    note: "Requires Gemini CLI auth/setup before the bridge starts.",
    packageUrl: "https://www.npmjs.com/package/@google/gemini-cli",
  },
  {
    name: "GitHub Copilot",
    npmPackage: "@github/copilot",
    install: "npm install -g @github/copilot",
    command: "copilot",
    args: ["--acp"],
    note: "Run the official Copilot login flow first.",
    packageUrl: "https://www.npmjs.com/package/@github/copilot",
  },
  {
    name: "Qwen Code",
    npmPackage: "@qwen-code/qwen-code",
    install: "npm install -g @qwen-code/qwen-code",
    command: "qwen",
    args: ["--acp", "--experimental-skills"],
    note: "Use the ACP flag set from the official registry.",
    packageUrl: "https://www.npmjs.com/package/@qwen-code/qwen-code",
  },
  {
    name: "Cline",
    npmPackage: "cline",
    install: "npm install -g cline",
    command: "cline",
    args: ["--acp"],
    note: "Install the CLI package; no custom bridge code needed.",
    packageUrl: "https://www.npmjs.com/package/cline",
  },
  {
    name: "Kilo Code",
    npmPackage: "@kilocode/cli",
    install: "npm install -g @kilocode/cli",
    command: "kilo",
    args: ["acp"],
    note: "The npm package exposes `kilo` / `kilocode` commands.",
    packageUrl: "https://www.npmjs.com/package/@kilocode/cli",
  },
  {
    name: "pi ACP",
    npmPackage: "pi-acp",
    install: "npm install -g pi-acp",
    command: "pi-acp",
    args: [],
    note: "ACP adapter for the pi coding agent.",
    packageUrl: "https://www.npmjs.com/package/pi-acp",
  },
];

function fallbackHttpBase(): string {
  return window.location.origin;
}

function fallbackWsBase(): string {
  return fallbackHttpBase().replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
      return;
    }
  } catch {
    /* handled below */
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (ok) toast.success("Copied");
  else toast.error("Copy failed");
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-0)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2">
        <span className="an-type-caption font-semibold uppercase text-[var(--fg-3)]">
          {label}
        </span>
        <button
          type="button"
          onClick={() => void copyText(code)}
          className="an-btn an-btn-ghost an-btn-sm"
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          <AppIcon name="copy" className="h-4 w-4" />
          Copy
        </button>
      </div>
      <pre className="an-type-caption overflow-x-auto p-3 font-mono leading-relaxed text-[var(--fg-1)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function formatArgs(args: string[]): string {
  return args.length ? `[${args.map((arg) => `"${arg}"`).join(", ")}]` : "[]";
}

function AgentPackageCard({ agent }: { agent: AgentPackage }) {
  const configLine = `command = "${agent.command}"\nargs = ${formatArgs(agent.args)}`;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-0)] p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="an-type-label">{agent.name}</p>
          <a
            href={agent.packageUrl}
            target="_blank"
            rel="noreferrer"
            className="an-type-caption break-all text-[var(--accent)] hover:underline"
          >
            {agent.npmPackage}
          </a>
        </div>
        <button
          type="button"
          onClick={() => void copyText(agent.install)}
          className="an-btn an-btn-ghost an-btn-sm shrink-0"
          aria-label={`Copy install command for ${agent.name}`}
          title={`Copy install command for ${agent.name}`}
        >
          <AppIcon name="copy" className="h-4 w-4" />
          Install
        </button>
      </div>
      <pre className="an-type-caption overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--surface-soft)] px-2 py-1.5 font-mono">
        <code>{agent.install}</code>
      </pre>
      <p className="an-type-caption mt-2 text-[var(--fg-3)]">{agent.note}</p>
      <p className="an-type-caption mt-2 whitespace-pre-wrap break-words font-mono text-[var(--fg-2)]">
        {configLine}
      </p>
    </div>
  );
}

function Section({
  children,
  id,
  title,
}: {
  children: ReactNode;
  id: string;
  title: string;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-[var(--border)] py-5">
      <h2 className="an-type-title mb-3">{title}</h2>
      {children}
    </section>
  );
}

export default function AcpBridgePage() {
  const [discovery, setDiscovery] = useState<DiscoveryData | null>(null);
  const [discoveryStatus, setDiscoveryStatus] = useState<"ready" | "fallback">("fallback");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      if (!cancelled) setDiscoveryStatus("fallback");
      controller.abort();
    }, 1500);
    fetch("/docs/agent-bridge/discovery", { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as DiscoveryResponse;
        if (!response.ok) throw new Error("Discovery unavailable");
        return payload.data ?? {};
      })
      .then((data) => {
        if (cancelled) return;
        setDiscovery(data);
        setDiscoveryStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setDiscovery(null);
        setDiscoveryStatus("fallback");
      })
      .finally(() => {
        window.clearTimeout(timeout);
      });
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  const urls = useMemo(() => {
    const base = discovery?.base_url || fallbackHttpBase();
    const wsBase = fallbackWsBase();
    return {
      base,
      discovery: discovery?.entrypoints?.discovery?.url || `${base}/docs/agent-bridge/discovery`,
      help: discovery?.entrypoints?.help_get?.url || `${base}/docs/agent-bridge/help?q=acp`,
      register: discovery?.entrypoints?.register?.url || `${base}/docs/agent-bridge/register`,
      controlWs: discovery?.bridge?.control_ws || `${wsBase}/ws/agent-bridge/control`,
      dataWs: discovery?.bridge?.data_ws || `${wsBase}/ws/agent-bridge/data`,
      fullGuide: `${base}/manual/help/AgentBridge接入指南`,
      registry: "https://agentclientprotocol.com/get-started/registry",
    };
  }, [discovery]);

  const packageInstallCommands = `# Pick ONE agent package. Do not install all of these unless you need them.
npm install -g @zed-industries/codex-acp
npm install -g @agentclientprotocol/claude-agent-acp
npm install -g opencode-ai
npm install -g @google/gemini-cli
npm install -g @github/copilot
npm install -g @qwen-code/qwen-code
npm install -g cline
npm install -g @kilocode/cli
npm install -g pi-acp`;

  const checkCommands = `which <installed-acp-command>
<installed-acp-command> --help
# If the agent requires login, run its official login command before continuing.`;

  const registerCurl = `curl -X POST ${urls.register} \\
  -H 'Content-Type: application/json' \\
  -d '{
    "username": "opencode-main",
    "bridge_provider": "acp",
    "account_username": "<agentnexus-user>",
    "account_password": "<agentnexus-password>",
    "agent_id": "opencode-main",
    "scope": "private"
  }'`;

  const bearerRegisterCurl = `curl -X POST ${urls.register} \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer <agentnexus-access-token>' \\
  -d '{
    "username": "opencode-main",
    "bridge_provider": "acp",
    "agent_id": "opencode-main",
    "scope": "private"
  }'`;

  const configToml = `version = 1

[daemon]
state_path = "./state.json"
log_dir = "./logs"

[accounts."opencode-main".bridge]
control_url = "${urls.controlWs}"
data_url = "${urls.dataWs}"
bot_token_env = "AGENTNEXUS_BOT_TOKEN"

[accounts."opencode-main".adapter]
type = "stdio"
command = "opencode"
args = ["acp", "--cwd", "/Users/me/project"]

[accounts."opencode-main".policy.workspace]
default_cwd = "/Users/me/project"
allowed_roots = ["/Users/me/project"]
backend_may_set_cwd = false

[accounts."opencode-main".policy.filesystem.read]
allow = true
allowed_roots = ["/Users/me/project"]

[accounts."opencode-main".policy.filesystem.write]
allow = true
allowed_roots = ["/Users/me/project"]

[accounts."opencode-main".policy.terminal]
allow = true

[accounts."opencode-main".policy.env]
inherit = false
allow = ["PATH", "HOME", "OPENCODE_OPENAI_API_KEY"]

[accounts."opencode-main".policy.permission]
forward_to_backend = true
wait_timeout_ms = 900000
on_timeout = "cancel"

[accounts."opencode-main".policy.mcp]
inject_agentnexus = true
backend_may_inject_extra_servers = false
allowed_servers = ["agentnexus"]

[accounts."opencode-main".policy.loopback]
allowed_resources = ["channel.messages.context", "channel.files.read"]
deny_resources = ["fs.write"]
request_timeout_ms = 600000`;

  const installCommands = `cargo install --path packages/agentnexus-acp-connector-rs --locked
agentnexus-acp-connector --help`;

  const runCommands = `export AGENTNEXUS_BOT_TOKEN=agb_xxx
agentnexus-acp-connector run --config ./agentnexus-daemon.toml

# After the first successful run, keep it alive with daemon mode:
agentnexus-acp-connector start --config ./agentnexus-daemon.toml --name opencode-main
agentnexus-acp-connector status --name opencode-main
agentnexus-acp-connector logs --name opencode-main --lines 120`;

  return (
    <div
      className="an-token-page bg-[var(--bg-0)] text-[var(--fg-1)]"
      style={{ minHeight: "var(--an-viewport-height, 100dvh)" }}
    >
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg-1)]/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Link to="/" className="an-btn an-btn-ghost an-btn-sm">
            <AppIcon name="arrowLeft" className="h-4 w-4" />
            Back
          </Link>
          <div className="min-w-0">
            <h1 className="an-type-title truncate">ACP Bridge</h1>
            <p className="an-type-meta truncate">Connect a local ACP stdio agent to AgentNexus.</p>
          </div>
          <div className="flex-1" />
          <a href={urls.discovery} className="an-btn an-btn-sm hidden sm:inline-flex">
            <AppIcon name="externalLink" className="h-4 w-4" />
            Discovery
          </a>
          <a href={urls.fullGuide} className="an-btn an-btn-primary an-btn-sm hidden sm:inline-flex">
            <AppIcon name="file" className="h-4 w-4" />
            Full guide
          </a>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[280px_1fr]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-1)] p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--accent-muted)] text-[var(--accent)]">
                <AppIcon name="zap" className="h-5 w-5" />
              </span>
              <div>
                <div className="an-type-label">Setup checklist</div>
                <div className="an-type-caption text-[var(--fg-3)]">
                  {discoveryStatus === "ready"
                    ? "Using live AgentNexus URLs"
                    : "Using local fallback URLs"}
                </div>
              </div>
            </div>
            <nav className="space-y-1">
              {setupSteps.map((step) => (
                <a
                  key={step.id}
                  href={`#${step.id}`}
                  className="block rounded-md border border-transparent px-3 py-2 text-left hover:border-[var(--border)] hover:bg-[var(--surface-soft)]"
                >
                  <span className="an-type-body font-medium">{step.title}</span>
                  <span className="an-type-caption mt-0.5 block text-[var(--fg-3)]">
                    {step.summary}
                  </span>
                </a>
              ))}
            </nav>
          </div>
        </aside>

        <div className="space-y-5">
          <section className="border-b border-[var(--border)] pb-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="an-chip accent">ACP stdio</span>
              <span className="an-chip">Rust connector</span>
              <span className="an-chip">WebSocket bridge</span>
            </div>
            <h2 className="mb-2 text-2xl font-semibold leading-tight tracking-normal text-[var(--fg-1)]">
              Install an ACP agent, register the Bot, run the Rust connector.
            </h2>
            <p className="an-type-body max-w-3xl leading-relaxed text-[var(--fg-2)]">
              Do not write a custom ACP adapter for common agents. Install a ready-made ACP runtime,
              then let the Rust `agentnexus-acp-connector` bridge that local stdio process to
              AgentNexus over WebSocket.
            </p>
            <p className="an-type-caption mt-3 max-w-3xl rounded-md border border-[var(--orange-muted)] bg-[var(--orange-muted)] px-3 py-2 text-[var(--orange)]">
              The old TypeScript connector package has been removed. New deployments use the Rust
              connector plus a local ACP-capable agent.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 sm:hidden">
              <a href={urls.discovery} className="an-btn an-btn-sm">
                <AppIcon name="externalLink" className="h-4 w-4" />
                Discovery
              </a>
              <a href={urls.fullGuide} className="an-btn an-btn-primary an-btn-sm">
                <AppIcon name="file" className="h-4 w-4" />
                Full guide
              </a>
            </div>
          </section>

          <Section id="packages" title="1. Install a ready-made ACP agent">
            <p className="an-type-body mb-3 text-[var(--fg-2)]">
              There are two local pieces: the Rust AgentNexus connector and one ACP-capable agent
              runtime. Install the connector once, then pick exactly one agent package from the list
              below for each Bot runtime.
            </p>
            <div className="mb-4 grid gap-4 xl:grid-cols-2">
              <CodeBlock
                label="install Rust AgentNexus connector"
                code="cargo install --path packages/agentnexus-acp-connector-rs --locked"
              />
              <CodeBlock label="install one common agent package" code={packageInstallCommands} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {commonAgentPackages.map((agent) => (
                <AgentPackageCard key={agent.npmPackage} agent={agent} />
              ))}
            </div>
            <p className="an-type-caption mt-3 text-[var(--fg-3)]">
              If your agent is not listed, check the official ACP registry and use its npm package
              or official CLI command instead of writing a new connector.
            </p>
            <a
              href={urls.registry}
              target="_blank"
              rel="noreferrer"
              className="an-btn an-btn-sm mt-3 inline-flex"
            >
              <AppIcon name="externalLink" className="h-4 w-4" />
              ACP agent registry
            </a>
          </Section>

          <Section id="check" title="2. Check the ACP runtime">
            <p className="an-type-body mb-3 text-[var(--fg-2)]">
              Do this on the machine that will run the agent. Use the command from the package card,
              for example `codex-acp`, `claude-agent-acp`, `opencode acp`, or `gemini --acp`.
            </p>
            <CodeBlock label="runtime check" code={checkCommands} />
            <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-soft)] p-3">
              <p className="an-type-label mb-1">Ready means all three are true</p>
              <ul className="an-type-body list-disc space-y-1 pl-5 text-[var(--fg-2)]">
                <li>The installed command is found by `which`.</li>
                <li>The command can start in a terminal without an interactive setup wizard.</li>
                <li>Any required login or API key setup is complete.</li>
              </ul>
            </div>
          </Section>

          <Section id="register" title="3. Register an AgentNexus Bot">
            <p className="an-type-body mb-3 text-[var(--fg-2)]">
              Register creates the AgentNexus Bot and returns `bot_token` plus Agent Bridge control
              and data URLs. The token is shown once, so store it in an environment variable rather
              than writing it into TOML.
            </p>
            <div className="grid gap-4 xl:grid-cols-2">
              <CodeBlock label="register with account password" code={registerCurl} />
              <CodeBlock label="register with bearer token" code={bearerRegisterCurl} />
            </div>
          </Section>

          <Section id="config" title="4. Save the connector config">
            <p className="an-type-body mb-3 text-[var(--fg-2)]">
              Save a local `./agentnexus-daemon.toml` file. The bridge URLs and token env name map to
              Agent Bridge; all local safety boundaries live under `policy.*`. Use the exact
              `command` and `args` shown in the package card you selected.
            </p>
            <CodeBlock label="agentnexus-daemon.toml" code={configToml} />
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div className="rounded-md border border-[var(--border)] p-3">
                <p className="an-type-label">command</p>
                <p className="an-type-caption text-[var(--fg-3)]">The executable installed by the npm package.</p>
              </div>
              <div className="rounded-md border border-[var(--border)] p-3">
                <p className="an-type-label">cwd</p>
                <p className="an-type-caption text-[var(--fg-3)]">The project folder the agent may read and write.</p>
              </div>
              <div className="rounded-md border border-[var(--border)] p-3">
                <p className="an-type-label">policy.*</p>
                <p className="an-type-caption text-[var(--fg-3)]">The local authorization boundary for cwd, env, files, terminal, resources, and permissions.</p>
              </div>
            </div>
          </Section>

          <Section id="run" title="5. Start the connector">
            <p className="an-type-body mb-3 text-[var(--fg-2)]">
              Foreground mode is best for the first run because errors stay in the terminal. Daemon
              mode is better once the bridge is stable.
            </p>
            <div className="grid gap-4 xl:grid-cols-2">
              <CodeBlock label="install connector" code={installCommands} />
              <CodeBlock label="run connector" code={runCommands} />
            </div>
          </Section>

          <Section id="verify" title="6. Verify from both sides">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-md border border-[var(--border)] p-3">
                <p className="an-type-label">Connector side</p>
                <ul className="an-type-body mt-2 list-disc space-y-1 pl-5 text-[var(--fg-2)]">
                  <li>`status` reports running.</li>
                  <li>Logs show both WebSocket streams connected.</li>
                  <li>The ACP runtime process starts without auth or setup prompts.</li>
                </ul>
              </div>
              <div className="rounded-md border border-[var(--border)] p-3">
                <p className="an-type-label">AgentNexus side</p>
                <ul className="an-type-body mt-2 list-disc space-y-1 pl-5 text-[var(--fg-2)]">
                  <li>The Bot appears online in Bot settings.</li>
                  <li>The Bot is a member of the target channel or DM scope.</li>
                  <li>`@opencode-main confirm you are connected` returns a reply.</li>
                </ul>
              </div>
            </div>
          </Section>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-1)] p-5">
            <h2 className="an-type-title mb-3">Fast troubleshooting</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {[
                ["Command not found", "Install the matching ACP runtime, then fix `command` and `args`."],
                ["Auth error", "Log in with the ACP agent's own CLI, then restart the connector."],
                ["Token lost", "Rotate the Agent Bridge token in AgentNexus Bot settings and update the config."],
                ["No reply", "Check channel membership, connector logs, and WebSocket reachability."],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-[var(--border)] p-3">
                  <p className="an-type-label">{title}</p>
                  <p className="an-type-caption mt-1 text-[var(--fg-3)]">{detail}</p>
                </div>
              ))}
            </div>
            <a href={urls.help} className="an-btn an-btn-sm mt-4 inline-flex">
              <AppIcon name="help" className="h-4 w-4" />
              Open Agent Bridge help
            </a>
          </section>
        </div>
      </main>
    </div>
  );
}
